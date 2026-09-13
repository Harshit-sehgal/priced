-- Migration 20260913_000004 — write the role privilege model down explicitly.
--
-- The portable bootstrap and the migrations assumed the Supabase baseline:
-- its default privileges grant USAGE on `public` and ALL on tables to anon,
-- authenticated and service_role. On any database without that baseline (plain
-- Postgres, or a project whose baseline was not inherited), the app's
-- service-role client cannot even read domains/sales/profiles, while
-- anon/authenticated depend on RLS alone for the money and moderation tables.
-- The schema-equivalence check could not see this: it creates the three roles
-- with NO privileges on both sides, so both sources were equally incomplete
-- and the diff passed.
--
-- This migration makes the intended model explicit and portable:
--   * schema USAGE for the three roles;
--   * public SELECT for the DISCOVERY tables (domains, sales) and the public
--     profile columns only — never `profiles` table-level SELECT, which would
--     undo the suspended_at column privacy from 20260912_000004;
--   * explicit DENY for money/moderation tables on top of RLS (defense in
--     depth: RLS already blocks them, this removes the table-level grant too);
--   * full DML for service_role on every app table it reads or writes.
--
-- Behaviour on hosted Supabase is a no-op or a strict tightening; nothing the
-- app relies on is granted to a client role here.

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

-- Future tables created in this schema inherit the server-role grant on
-- Supabase-like databases; on plain Postgres the default stays owner-only.
alter default privileges in schema public grant all on tables to service_role;

-- The last two SECURITY DEFINER functions omitted pg_temp from their
-- search_path. Every relation reference inside them is schema-qualified, so
-- this is not exploitable today; pg_temp is included for the same defence the
-- refund/retention RPCs already use.
alter function public.finalize_takeover(text, uuid, text, bigint, bigint, text)
  set search_path = public, pg_temp;
alter function public.holder_analytics(text, timestamptz)
  set search_path = public, pg_temp;
