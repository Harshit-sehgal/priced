-- Migration 20260913_000005 — one payment id, one outcome: sale OR refund.
--
-- BUG: `finalize_takeover` checked only `sales`; `claim_refund_attempt` checked
-- only `refunds`. A single provider payment id could therefore both fund a
-- takeover AND be refunded:
--
--   Sequential, no concurrency required:
--     E1 (payment.succeeded, amount re-derived tax-inclusive) -> no sale ->
--     quote active -> amount_mismatch -> refund SUCCEEDS. The amount-mismatch
--     branch does not make the quote terminal.
--     E2 (a second event id for the SAME payment, correct net amount) -> no
--     sale -> quote still active -> amount matches -> sale CREATED.
--     Buyer keeps the tag AND the money.
--
--   Concurrent at the quote-expiry boundary:
--     E1 reads the quote before expiry and enters finalize; E2 reads after
--     expiry, marks it expired and refunds; E1's finalize commits.
--
-- FIX: both sides serialize on one transaction-scoped advisory lock keyed by
-- the payment id, and each refuses when the other's outcome already exists:
--   * finalize_takeover takes the lock, then rejects any payment with a
--     `refunds` row (attempting/succeeded/manual_review/failed — a refund
--     intent means the payment must not fund a sale; the ledger converges it).
--   * claim_refund_attempt takes the same lock, then refuses when a `sales`
--     row exists for the payment id (returning `already_finalized`).
--   * reconcile_refund_event moves the provider-event upsert into SQL so the
--     refund.succeeded/failed path takes the same lock, closing the
--     dashboard-refund-racing-a-webhook window too.
--
-- The domain row lock still orders takeovers; the advisory lock orders
-- payment disposition. Deadlock is impossible: finalize takes the advisory
-- lock BEFORE the domain lock, and claim/reconcile take only the advisory lock.
--
-- Also carried forward: the reserved-domain check now runs AFTER the domain
-- row is locked, so a reservation committed before the lock is always seen
-- (the operator path still takes no lock, so a reservation racing the final
-- commit remains theoretically possible and is handled by the documented
-- refund procedure).

create index if not exists refunds_payment_id_idx on public.refunds(provider_payment_id);

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
  -- reconcile_refund_event, then refuse a payment that has a refund intent.
  perform pg_advisory_xact_lock(hashtextextended(p_provider_payment_id, 0));
  if exists (
    select 1 from public.refunds where provider_payment_id = p_provider_payment_id
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

-- SECURITY DEFINER functions are executable by PUBLIC unless explicitly revoked.
revoke all on function public.finalize_takeover(text, uuid, text, bigint, bigint, text) from public;
grant execute on function public.finalize_takeover(text, uuid, text, bigint, bigint, text) to service_role;

-- Claiming is serialized in Postgres. An expired in-flight claim is moved to
-- manual_review instead of being retried automatically: a provider timeout
-- may have succeeded, so an unbounded second refund could double-refund.
-- Now also serialized against finalize_takeover: a payment that already funded
-- a sale is never refundable.
create or replace function public.claim_refund_attempt(
  p_provider text,
  p_provider_payment_id text,
  p_provider_event_id text,
  p_reason text,
  p_amount_cents bigint default null,
  p_max_attempts integer default 3,
  p_lease_seconds integer default 600
)
returns table(claimed boolean, status text, attempts integer, claim_token uuid, last_error text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.refunds%rowtype;
  now_ts timestamptz := clock_timestamp();
  next_token uuid := gen_random_uuid();
  max_attempts integer := greatest(1, p_max_attempts);
  lease_seconds integer := greatest(1, p_lease_seconds);
  inserted_count integer := 0;
begin
  if nullif(trim(p_provider), '') is null
     or nullif(trim(p_provider_payment_id), '') is null
     or nullif(trim(p_provider_event_id), '') is null
     or nullif(trim(p_reason), '') is null then
    raise exception 'refund claim requires provider, payment, event and reason';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_provider_payment_id, 0));
  if exists (
    select 1 from public.sales where provider_payment_id = p_provider_payment_id
  ) then
    return query select false, 'already_finalized'::text, 0, null::uuid,
      'sale_exists: payment already funded a takeover';
    return;
  end if;

  insert into public.refunds (
    provider, provider_payment_id, provider_event_id, reason, amount_cents,
    status, attempts, claim_token, lease_expires_at, last_attempt_at, updated_at
  ) values (
    p_provider, p_provider_payment_id, p_provider_event_id, p_reason, p_amount_cents,
    'attempting', 1, next_token,
    now_ts + make_interval(secs => lease_seconds::double precision), now_ts, now_ts
  ) on conflict (provider, provider_payment_id) do nothing;
  get diagnostics inserted_count = row_count;

  select * into r from public.refunds
  where provider = p_provider and provider_payment_id = p_provider_payment_id
  for update;

  if inserted_count = 1 then
    return query select true, 'attempting'::text, 1, next_token, null::text;
    return;
  end if;
  if r.status in ('succeeded', 'manual_review') then
    return query select false, r.status, r.attempts, r.claim_token, r.last_error;
    return;
  end if;
  if r.status = 'attempting' then
    if r.claim_token is not null and r.lease_expires_at is not null and r.lease_expires_at > now_ts then
      return query select false, r.status, r.attempts, r.claim_token, r.last_error;
      return;
    end if;
    update public.refunds set status = 'manual_review', claim_token = null,
      lease_expires_at = null, last_error = coalesce(last_error, 'refund attempt lease expired'), updated_at = now_ts
      where id = r.id;
    return query select false, 'manual_review'::text, r.attempts, null::uuid,
      coalesce(r.last_error, 'refund attempt lease expired');
    return;
  end if;
  if r.attempts >= max_attempts then
    update public.refunds set status = 'manual_review', claim_token = null,
      lease_expires_at = null, updated_at = now_ts where id = r.id;
    return query select false, 'manual_review'::text, r.attempts, null::uuid, r.last_error;
    return;
  end if;
  update public.refunds set status = 'attempting', attempts = r.attempts + 1,
    claim_token = next_token,
    lease_expires_at = now_ts + make_interval(secs => lease_seconds::double precision),
    last_attempt_at = now_ts, updated_at = now_ts
    where id = r.id returning * into r;
  return query select true, r.status, r.attempts, r.claim_token, r.last_error;
end;
$$;

revoke all on function public.claim_refund_attempt(text, text, text, text, bigint, integer, integer) from public;
revoke all on function public.claim_refund_attempt(text, text, text, text, bigint, integer, integer) from anon, authenticated;
grant execute on function public.claim_refund_attempt(text, text, text, text, bigint, integer, integer) to service_role;

-- Provider-emitted refund reconciliation, serialized on the same payment lock.
-- Carries the `status <> 'succeeded'` no-downgrade rule from the TS layer into
-- SQL (FOR UPDATE makes it authoritative) and closes the window where a
-- dashboard refund event could insert a refund row concurrently with a
-- takeover finalization.
create or replace function public.reconcile_refund_event(
  p_provider text,
  p_provider_payment_id text,
  p_provider_event_id text,
  p_status text,
  p_amount_cents bigint default null,
  p_error text default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing public.refunds%rowtype;
  now_ts timestamptz := clock_timestamp();
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

  select * into existing from public.refunds
  where provider = p_provider and provider_payment_id = p_provider_payment_id
  for update;

  if found then
    -- A settled refund is terminal: a later refund.failed must never
    -- downgrade it to manual_review (an operator could then refund twice).
    if existing.status = 'succeeded' then
      return existing.status;
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
    return p_status;
  end if;

  insert into public.refunds (
    provider, provider_payment_id, provider_event_id, reason, amount_cents,
    status, attempts, last_error, updated_at, completed_at
  ) values (
    p_provider, p_provider_payment_id, p_provider_event_id, 'provider_refund_event',
    p_amount_cents, p_status, 0, p_error, now_ts, now_ts
  );
  return p_status;
end;
$$;

revoke all on function public.reconcile_refund_event(text, text, text, text, bigint, text) from public;
revoke all on function public.reconcile_refund_event(text, text, text, text, bigint, text) from anon, authenticated;
grant execute on function public.reconcile_refund_event(text, text, text, text, bigint, text) to service_role;
