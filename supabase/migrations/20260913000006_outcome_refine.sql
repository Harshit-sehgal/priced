-- Migration 20260913_000006 — make the outcome-exclusion verdicts atomic and
-- let definitively-failed refunds converge.
--
-- Two refinements to 20260913000005:
--
-- 1. `reconcile_refund_event` now checks `sales` UNDER the advisory lock and
--    reports whether a sale exists. The webhook route previously did that
--    lookup before calling reconcile, so a finalization committing in between
--    produced sale+refund with no `refund_after_sale` alert. The verdict is
--    now atomic with the row write.
--
-- 2. `finalize_takeover` blocks on refund intent only when the refund is NOT
--    definitively failed. `failed` is written only after the provider
--    answered (HTTP error status, or a recognized `failed` status) — no money
--    moved — so a later correct-amount success event may finalize. Without
--    this, a single failed refund attempt parked the payment forever (no sale,
--    no refund, no automatic path) while the provider stopped redelivering.
--    `attempting`/`succeeded`/`manual_review` still block, atomically: the
--    advisory lock serializes finalize against any claim that would flip a
--    failed row back to attempting.
--
-- The refund/sale predicates are intentionally scoped by payment id only, not
-- provider: `sales` has no provider column, and requiring a refund row and a
-- sale row to agree on the provider would allow refund(providerA, X) to
-- coexist with sale(providerB, X), which is the outcome this whole mechanism
-- exists to prevent. Over-blocking on a contrived cross-provider id collision
-- is the safe direction.

-- Return type changes from text to table, so the old function must be dropped.
drop function if exists public.reconcile_refund_event(text, text, text, text, bigint, text);

create or replace function public.reconcile_refund_event(
  p_provider text,
  p_provider_payment_id text,
  p_provider_event_id text,
  p_status text,
  p_amount_cents bigint default null,
  p_error text default null
)
returns table(status text, sale_exists boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing public.refunds%rowtype;
  now_ts timestamptz := clock_timestamp();
  sale_exists_held boolean := false;
begin
  if nullif(trim(p_provider), '') is null
     or nullif(trim(p_provider_payment_id), '') is null
     or nullif(trim(p_provider_event_id), '') is null then
    raise exception 'refund reconcile requires provider, payment and event';
  end if;
  if p_status is null or p_status not in ('succeeded', 'manual_review') then
    raise exception 'invalid refund reconcile status: %', p_status;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_provider_payment_id, 0));

  -- Same lock as finalize_takeover/claim_refund_attempt: the contradiction
  -- verdict cannot race a finalization.
  select exists (
    select 1 from public.sales where provider_payment_id = p_provider_payment_id
  ) into sale_exists_held;

  select * into existing from public.refunds
  where provider = p_provider and provider_payment_id = p_provider_payment_id
  for update;

  if found then
    -- A settled refund is terminal: a later refund.failed must never
    -- downgrade it to manual_review (an operator could then refund twice).
    if existing.status = 'succeeded' then
      return query select existing.status, sale_exists_held;
      return;
    end if;
    update public.refunds
    set status = p_status,
        provider_event_id = p_provider_event_id,
        claim_token = null,
        lease_expires_at = null,
        last_error = p_error,
        updated_at = now_ts,
        completed_at = now_ts,
        amount_cents = coalesce(p_amount_cents, amount_cents)
    where id = existing.id;
    return query select p_status, sale_exists_held;
    return;
  end if;

  insert into public.refunds (
    provider, provider_payment_id, provider_event_id, reason, amount_cents,
    status, attempts, last_error, updated_at, completed_at
  ) values (
    p_provider, p_provider_payment_id, p_provider_event_id, 'provider_refund_event',
    p_amount_cents, p_status, 0, p_error, now_ts, now_ts
  );
  return query select p_status, sale_exists_held;
end;
$$;

revoke all on function public.reconcile_refund_event(text, text, text, text, bigint, text) from public;
revoke all on function public.reconcile_refund_event(text, text, text, text, bigint, text) from anon, authenticated;
grant execute on function public.reconcile_refund_event(text, text, text, text, bigint, text) to service_role;

-- Redefine finalize so a definitively-failed refund no longer blocks a sale.
create or replace function public.finalize_takeover(
  p_domain text,
  p_buyer_user_id uuid,
  p_buyer_handle text,
  p_expected_version bigint,
  p_paid_cents bigint,
  p_provider_payment_id text
)
returns public.sales
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d public.domains%rowtype;
  s public.sales%rowtype;
  required_increment bigint;
  required_price bigint;
begin
  if p_domain is null or p_domain = '' then
    raise exception 'INVALID_DOMAIN';
  end if;
  if p_buyer_user_id is null or p_buyer_handle is null or p_buyer_handle = '' then
    raise exception 'INVALID_BUYER';
  end if;
  if p_provider_payment_id is null or btrim(p_provider_payment_id) = '' then
    raise exception 'INVALID_PAYMENT_ID';
  end if;

  -- Serialize payment disposition against claim_refund_attempt and
  -- reconcile_refund_event, then refuse a payment that has a LIVE refund
  -- intent. A `failed` row is excluded: it is only written after the provider
  -- definitively answered without refunding, so a later correct payment may
  -- still fund a sale (the lock makes the check-vs-retry race atomic).
  perform pg_advisory_xact_lock(hashtextextended(p_provider_payment_id, 0));
  if exists (
    select 1 from public.refunds
    where provider_payment_id = p_provider_payment_id
      and status <> 'failed'
  ) then
    raise exception 'PAYMENT_REFUNDING';
  end if;

  -- Fast path: a retried signed webhook returns the already-created sale
  -- without taking the row lock at all.
  select * into s from public.sales where provider_payment_id = p_provider_payment_id;
  if found then
    if p_paid_cents is null
       or s.domain <> p_domain
       or s.buyer_user_id <> p_buyer_user_id
       or s.price_cents <> p_paid_cents then
      raise exception 'IDEMPOTENCY_CONFLICT';
    end if;
    return s;
  end if;

  -- Materialize the canonical row so two first-claim attempts contend on one lock.
  insert into public.domains(domain) values (p_domain)
  on conflict (domain) do nothing;

  select * into d from public.domains where domain = p_domain for update;

  -- Blocklist check INSIDE the transaction, after the lock: a domain reserved
  -- between quote creation and finalization must still fail here, and a
  -- reservation committed before the lock is guaranteed to be visible.
  if exists (select 1 from public.reserved_domains where domain = p_domain) then
    raise exception 'RESERVED_DOMAIN';
  end if;

  -- Re-check idempotency now that the lock is HELD. A concurrent delivery of
  -- this same payment may have committed while we were parked above; without
  -- this the version check below would raise STALE_QUOTE and the caller would
  -- refund a sale that genuinely succeeded.
  select * into s from public.sales where provider_payment_id = p_provider_payment_id;
  if found then
    if p_paid_cents is null
       or s.domain <> p_domain
       or s.buyer_user_id <> p_buyer_user_id
       or s.price_cents <> p_paid_cents then
      raise exception 'IDEMPOTENCY_CONFLICT';
    end if;
    return s;
  end if;

  if p_expected_version is null or d.version <> p_expected_version then
    raise exception 'STALE_QUOTE';
  end if;
  if d.holder_user_id = p_buyer_user_id then
    raise exception 'ALREADY_HOLDER';
  end if;

  if d.price_cents = 0 or d.holder_user_id is null then
    required_price := 500;
  else
    -- 1% of current price, rounded upward to the next cent.
    required_increment := greatest(500::bigint, ceil(d.price_cents::numeric / 100)::bigint);
    required_price := d.price_cents + required_increment;
  end if;

  if p_paid_cents is null or p_paid_cents <> required_price then
    raise exception 'WRONG_PRICE expected %, got %', required_price, p_paid_cents;
  end if;

  update public.domains
  set holder_user_id = p_buyer_user_id,
      holder_handle = p_buyer_handle,
      price_cents = p_paid_cents,
      version = version + 1,
      claimed_at = coalesce(claimed_at, now()),
      updated_at = now()
  where domain = p_domain;

  insert into public.sales(
    domain, buyer_user_id, buyer_handle,
    previous_holder_user_id, previous_holder_handle,
    price_cents, previous_price_cents, domain_version,
    provider_payment_id
  ) values (
    p_domain, p_buyer_user_id, p_buyer_handle,
    d.holder_user_id, d.holder_handle,
    p_paid_cents, d.price_cents, d.version + 1,
    p_provider_payment_id
  ) returning * into s;

  return s;
end;
$$;

revoke all on function public.finalize_takeover(text, uuid, text, bigint, bigint, text) from public;
grant execute on function public.finalize_takeover(text, uuid, text, bigint, bigint, text) to service_role;
