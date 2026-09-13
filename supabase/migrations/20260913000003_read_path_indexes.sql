-- Migration 20260913_000003 — indexes for two hot read paths.
--
-- 1. listDomainsForHolder (holder profile "Currently held") filters
--    domains.holder_handle and orders by price. The domains table had only
--    domains_price_idx, which cannot serve a handle filter, so every public
--    profile view was a sequential scan with a sort. The composite index
--    serves both the filter and the order.
--
-- 2. The activity feed, "Most Fought Over" sampling, and Fastest Rising all
--    order sales by created_at DESC. The existing sales indexes are prefixed
--    by domain, buyer_handle or a partial first-claim predicate, so none can
--    drive that ordering; the newest-N reads were scanning and sorting the
--    whole ledger.
--
-- Both are idempotent and cheap; the money ledger is unaffected.

create index if not exists domains_holder_handle_price_idx
  on public.domains(holder_handle, price_cents desc);

create index if not exists sales_created_idx
  on public.sales(created_at desc);
