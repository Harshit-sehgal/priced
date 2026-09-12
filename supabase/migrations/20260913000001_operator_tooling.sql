-- Migration 20260913_000001 — operator moderation toolkit (§48).
--
-- WHY THIS MIGRATION EXISTS: this toolkit already existed in `db/ops.sql`, and
-- DEPLOY.md names it as THE correction procedure ("operator-correct via
-- db/ops.sql audit + reserved-domain/suspension actions"). But nothing ever
-- applied that file: it is not in the migration history, not in the
-- schema.sql + schema-extended.sql bootstrap, and not in the schema
-- equivalence check. So `admin_audit` and every `ops_*` function were almost
-- certainly absent from the hosted database, and the documented response to a
-- legal takedown or an abusive account would have failed with "function does
-- not exist" at exactly the moment it was needed.
--
-- Moderation tooling that is documented but not installed is not tooling.
--
-- Behaviour is otherwise identical to db/ops.sql, which is kept in sync as the
-- portable bootstrap copy and is now covered by `npm run test:schema`.

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
