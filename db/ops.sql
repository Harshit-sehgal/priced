-- Priced — operator moderation toolkit (§48).
-- PORTABLE COPY of supabase/migrations/20260913000001_operator_tooling.sql.
-- Applied as part of the bootstrap sequence (schema.sql, schema-extended.sql,
-- ops.sql) and covered by `npm run test:schema`, which diffs this against the
-- migration history. Keep the two in sync; the checker fails if they drift.

-- Audit trail for privileged actions.
create table if not exists public.admin_audit (
  id uuid primary key default gen_random_uuid(),
  action text not null,
  target text not null,
  detail jsonb,
  created_at timestamptz not null default now()
);

create index if not exists admin_audit_created_idx on public.admin_audit(created_at desc);

alter table public.admin_audit enable row level security;

-- Least privilege: these are service-role-only operator tools. Postgres grants
-- EXECUTE to PUBLIC by default and PostgREST exposes public-schema RPCs to
-- anon/authenticated, so without explicit revokes any anon-key holder could
-- suspend users or reserve domains. Never apply without these.
do $$
begin
  begin
    revoke all on table public.admin_audit from anon, authenticated;
  exception when undefined_object then null;
  end;
end $$;

-- Reserve a domain (brand protection / legal request).
-- `on conflict do nothing`: reserving an already-reserved domain must be a
-- no-op, not a unique-violation error. An operator acting on a takedown should
-- never have to care whether someone already did it.
create or replace function public.ops_reserve_domain(p_domain text, p_reason text, p_by text)
returns void language sql security definer set search_path = public as $$
  insert into public.reserved_domains(domain, reason, created_by)
  values (p_domain, p_reason, p_by)
  on conflict (domain) do nothing;
  insert into public.admin_audit(action, target, detail)
  values ('reserve_domain', p_domain, jsonb_build_object('reason', p_reason, 'by', p_by));
$$;

create or replace function public.ops_unreserve_domain(p_domain text, p_by text)
returns void language sql security definer set search_path = public as $$
  delete from public.reserved_domains where domain = p_domain;
  insert into public.admin_audit(action, target, detail)
  values ('unreserve_domain', p_domain, jsonb_build_object('by', p_by));
$$;

-- Suspend / unsuspend a user (blocks new quotes at the API layer, and blocks
-- finalization in takeover.ts).
create or replace function public.ops_suspend_user(p_handle text, p_by text)
returns void language sql security definer set search_path = public as $$
  update public.profiles set suspended_at = now() where handle = p_handle;
  insert into public.admin_audit(action, target, detail)
  values ('suspend_user', p_handle, jsonb_build_object('by', p_by));
$$;

create or replace function public.ops_unsuspend_user(p_handle text, p_by text)
returns void language sql security definer set search_path = public as $$
  update public.profiles set suspended_at = null where handle = p_handle;
  insert into public.admin_audit(action, target, detail)
  values ('unsuspend_user', p_handle, jsonb_build_object('by', p_by));
$$;

-- Usage:
-- select public.ops_reserve_domain('example.com', 'legal request', 'operator');
-- select public.ops_suspend_user('badactor', 'operator');

-- SECURITY DEFINER functions are executable by PUBLIC unless explicitly
-- revoked. Mirror the money-RPC hardening: service-role only.
--
-- On the redundancy below: `revoke ... from public` is the load-bearing line —
-- anon and authenticated hold EXECUTE only by inheriting the PUBLIC grant, and
-- mutation testing confirms that removing it makes anon able to suspend users
-- while removing the explicit anon/authenticated revokes changes nothing today.
-- They are kept deliberately: they cost nothing and they still bite if someone
-- later grants those roles EXECUTE directly. Do not delete them as dead code.
do $$
begin
  begin
    revoke all on function public.ops_reserve_domain(text, text, text) from public;
    revoke all on function public.ops_reserve_domain(text, text, text) from anon, authenticated;
    grant execute on function public.ops_reserve_domain(text, text, text) to service_role;
    revoke all on function public.ops_unreserve_domain(text, text) from public;
    revoke all on function public.ops_unreserve_domain(text, text) from anon, authenticated;
    grant execute on function public.ops_unreserve_domain(text, text) to service_role;
    revoke all on function public.ops_suspend_user(text, text) from public;
    revoke all on function public.ops_suspend_user(text, text) from anon, authenticated;
    grant execute on function public.ops_suspend_user(text, text) to service_role;
    revoke all on function public.ops_unsuspend_user(text, text) from public;
    revoke all on function public.ops_unsuspend_user(text, text) from anon, authenticated;
    grant execute on function public.ops_unsuspend_user(text, text) to service_role;
  exception when undefined_object then null;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- Role privilege model (portable mirror of 20260913000004_role_grants.sql).
--
-- The Supabase baseline grants usage/table privileges to these roles by
-- default; this bootstrap must not depend on it. Money/moderation tables are
-- explicitly denied to client roles on top of RLS, discovery tables keep
-- public SELECT, and profiles keeps only its public COLUMN grants (a
-- table-level grant would expose suspended_at). service_role gets the DML the
-- server client needs.
do $$
begin
  begin
    grant usage on schema public to anon, authenticated, service_role;
  exception when undefined_object or insufficient_privilege then null;
  end;

  begin
    grant select on table public.domains, public.sales to anon, authenticated;
  exception when undefined_object or insufficient_privilege then null;
  end;

  begin
    grant select (id, handle, display_name, avatar_url, created_at, bio, cta_label, cta_url)
      on table public.profiles to anon, authenticated;
  exception when undefined_object or insufficient_privilege then null;
  end;

  begin
    revoke all on table
      public.payment_events,
      public.refunds,
      public.payment_disputes,
      public.reserved_domains,
      public.credit_ledger,
      public.admin_audit,
      public.analytics_events
      from anon, authenticated;
  exception when undefined_object or insufficient_privilege then null;
  end;

  begin
    grant select, insert, update, delete on table
      public.domains,
      public.sales,
      public.profiles,
      public.quotes,
      public.payment_events,
      public.refunds,
      public.payment_disputes,
      public.reserved_domains,
      public.analytics_events,
      public.credit_ledger,
      public.admin_audit
      to service_role;
  exception when undefined_object or insufficient_privilege then null;
  end;
end $$;

alter default privileges in schema public grant all on tables to service_role;

alter function public.finalize_takeover(text, uuid, text, bigint, bigint, text)
  set search_path = public, pg_temp;
alter function public.holder_analytics(text, timestamptz)
  set search_path = public, pg_temp;

-- ---------------------------------------------------------------------------
-- Reserving a tag that is CURRENTLY HELD carries a refund obligation (Terms
-- §7, Refund Policy). This app has no automated post-sale refund path: the
-- refund ledger exists for payments that never funded a takeover. An operator
-- handles it manually, in order:
--   1. find the last funded payment for the tag;
--   2. issue the full refund in the payment provider dashboard with a reason
--      like "operator reservation" (test mode first);
--   3. record the reservation, naming the refund in the audit detail.
-- Step 1:
--   select s.buyer_handle, s.price_cents, s.provider_payment_id, s.created_at
--   from public.sales s
--   where s.domain = $1
--   order by s.created_at desc
--   limit 1;
-- Step 3:
--   select public.ops_reserve_domain('example.com', 'legal request; refunded pay_abc', 'operator');
