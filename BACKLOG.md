# Backlog — parallel work distribution

> How to finish the remaining production work quickly. Each lane can be taken
> by a different person/agent without blocking the others. Do the owner-gated
> lane first — everything else depends on it.

Status: `code` = work to do in this repo · `owner` = needs accounts/credentials/legal · `verify` = run on a real deployment. Current evidence is recorded in `LAUNCH_CHECKLIST.md` and `INTEGRATION_NOW.md`.

Active hosting override (2026-09-12): the free beta runs on Cloudflare
Workers at `https://priced.harshit10sehgal.workers.dev`. Vercel remains a
rollback/reference deployment; older Vercel wording in the historical evidence
below does not identify the active beta origin.

Latest sandbox status (2026-09-18) supersedes older matrix wording below:
the hosted 25-payment batch completed in Dodo Test Mode with one consumed
quote/sale, eight stale quotes, sixteen TTL-expired quotes, and 24 succeeded
refund-ledger rows totaling `$120.00`. A strict same-version 25-way timing
run remains **External provider blocked** because the deployed eight-per-window
quote limiter and five-minute TTL cannot be satisfied with one signed-in
challenger account.

## Lane A — Owner-gated infra (do first, blocks all real-money verification)

| # | Task | Type | Owner | Notes |
|---|------|------|-------|-------|
| A1 | Verify the existing **Supabase** project + hosted hardening state; apply only missing migrations if any | owner | repo owner | **Staging verified** for project, migrations, health, auth, hosted logical backup dump/restore, and the real service-role RPC harness (all 8 tests passed). Managed backups remain unavailable on the Free Plan. `INTEGRATION_NOW.md` · `DEPLOY.md §1` |
| A2 | Enable **Supabase Auth** providers (Google OAuth + email magic link) + set Site URL + redirect URLs | owner | owner | **Staging verified** for Google OAuth, callback, welcome, logout/re-login, and saved `@harshit` handle |
| A3 | Enable **Supabase Realtime**; keep PITR off during free beta and test logical backups before real money | owner | owner | **Staging verified** for a live two-session market update and a hosted logical schema/data dump restored into isolated PostgreSQL 17. Supabase Free Plan explicitly excludes managed project backups; PITR remains off. `DEPLOY.md §7` |
| A4 | Create one free **Upstash Redis** DB for the designated beta environment and set `UPSTASH_REDIS_REST_URL/TOKEN` there | owner | owner | **Staging verified**: `priced-beta-redis` is wired to the active Cloudflare beta deployment, direct Redis checks pass, and clean concurrent hosted bursts hit every configured user/IP/domain ceiling with the next request returning 429 and no 5xx. Disposable Auth users, profiles, and quotes were removed. `DEPLOY.md §3`; ordinary untrusted previews stay secret-free |
| A5 | Get **test** credentials + create/reuse approved PWYW one-time product → copy `DODO_PAYMENTS_PRODUCT_ID` | owner | owner | **Staging verified** for configured Dodo Test Mode product and real checkout. `DEPLOY.md §2` · `DODO_COMPLIANCE_GATE.md` |
| A6 | Add Dodo webhook `https://<domain>/api/webhooks/payments` (test endpoint) → copy `DODO_PAYMENTS_WEBHOOK_KEY` | owner | owner | **Staging verified (partial)**: signed success, failed payment, duplicate-event replay/idempotency, provider replay of a successful event with a new HTTP 200 delivery, synthetic provider `payment.failed` and `payment.cancelled` delivery with HTTP 200, a real customer-cancellation state transition with `payment.cancelled` delivered HTTP 200, fail-closed synthetic missing-metadata/refund-failure retry behavior, a real missing-metadata payment with successful full refund and no matching sale, cancelled-checkout UI behavior, tax-inclusive amount handling, stale/wrong-amount refunds, endpoint delivery reached the hosted endpoint, provider-outage handling, a hosted 25-payment batch with exactly one sale and 24 succeeded refunds, and a hosted terminal-quote payment/refund race. The endpoint currently subscribes to all 12 required payment, refund, and dispute events; asynchronous refund statuses are fail-closed and reconciled through `refund.succeeded`/`refund.failed`. The clean same-version 25-way timing gate remains **External provider blocked** because one signed-in account cannot create and pay 25 quotes inside the five-minute TTL under the deployed eight-per-window limiter. Subscribe to `payment.succeeded`, `payment.failed`, `payment.cancelled`, `refund.succeeded`, `refund.failed`, and the seven dispute lifecycle events |
| A7 | **Cloudflare Workers**: deploy the designated free beta and keep previews secret-free | owner | owner | **Staging verified**: Worker `priced` serves the stable beta origin with Supabase, Dodo Test Mode, and Upstash wired; Vercel remains rollback-only. `DEPLOY.md §3` |
| A8 | Set `SENTRY_DSN` + persistent error alerting + `/api/health` uptime check; alert on `refund_failed`, `takeover_finalization_error`, `webhook_*_failed`, `webhook_signature_invalid` spikes | owner | owner | **Implemented (partial)**: `.github/workflows/staging-health.yml` checks Cloudflare liveness, Supabase readiness, and Redis readiness every 15 minutes with GitHub Actions failure notifications. Persistent structured-error alert routing still needs an authorized destination; Cloudflare live tail is available for diagnostics. `DEPLOY.md §8` |
| A9 | Turnstile widget (optional) + Dodo fraud/risk features in dashboard | owner | owner | `DEPLOY.md §3` |

## Lane B — Staging verification (needs Lane A preview env)

| # | Task | Type | Depends | How |
|---|------|------|---------|-----|
| B1 | **Dodo sandbox matrix** (§76 gate) — complete cancel/duplicate/stale/simultaneous/refund-failure/missing-metadata/wrong-amount/outage cases on the hosted beta with test keys | verify | A5–A7 | **Staging verified (partial)** for success/fail/signed webhook/duplicate replay/provider replay with HTTP 200/synthetic `payment.failed` and `payment.cancelled` delivery with HTTP 200/a real customer-cancellation state transition with `payment.cancelled` delivered HTTP 200/fail-closed synthetic missing-metadata/refund-failure retry behavior/a real missing-metadata payment with successful full refund and no matching sale/cancelled-checkout UI/atomic finalization, tax-inclusive amount handling, stale/wrong-amount refunds, provider outage, a hosted 25-payment batch with exactly one sale and 24 succeeded refunds, and a hosted terminal-quote payment/refund race. The clean same-version 25-way timing gate remains **External provider blocked** because one signed-in account cannot create and pay 25 quotes inside the five-minute TTL under the deployed eight-per-window limiter. |
| B2 | **Real Postgres concurrency** — run `tests/integration/postgres.finalize.test.ts` against the real Priced Supabase project | verify | A1 | **Staging verified**: the real service-role harness passed all 8 tests, and a bounded hosted database pool separately submitted 10 first claims (1 `OK`, 9 `STALE_QUOTE`) and 25 held-domain takeovers (1 `OK`, 24 `STALE_QUOTE`), then cleaned both test domains. The protected key was held transiently in memory and never printed or stored. `npm run test:postgres` now points to the correct integration harness; hosted logical backup dump/restore is documented in `DEPLOY.md §7`. |
| B3 | **Staging smoke** — health, analytics taxonomy, CSRF guards, auth redirect, routing | verify | A7 | **Staging verified**: `STAGING_URL=https://priced.harshit10sehgal.workers.dev npm run smoke:staging` passes all 10 checks, including the custom 404 route and every public HTML route |
| B4 | **Realtime** + browser loop on staging — search → domain → quote → checkout → webhook → sale → receipt → profile → market update → share | verify | A1–A7 | **Staging verified** for hosted success journey, profile, analytics, receipt, share, and live two-session Realtime update; the full payment/race matrix remains. `tests/browser/loop.spec.ts` against `STAGING_URL` + manual check |
| B5 | **Rate-limit across instances** — prove 429s from Upstash (burst quote/checkout/handle) on the hosted beta with Redis | verify | A4 | **Staging verified**: clean concurrent hosted bursts verified handle user/IP `5/15`, profile user `10`, quote user/IP/domain/user+domain `30/60/30/8`, and checkout user/IP `20/30`; each next request returned `429 rate_limited` with no 5xx. `tests/load/race.mjs` already accounts for 429s. |

## Lane C — Code hardening (can run in parallel, no infra needed)

| # | Task | Type | Files | Done |
|---|------|------|-------|------|
| C1 | Layered rate limits (domain + user+domain) + 4 KiB payload guard on quotes | code | `src/app/api/quotes/route.ts` | ✅ |
| C2 | 4 KiB payload guard + body-size check on checkout | code | `src/app/api/checkout/route.ts` | ✅ |
| C3 | IP-layer rate limit + 4 KiB payload guard on handle | code | `src/app/api/handle/route.ts` | ✅ |
| C4 | 64 KiB payload guard on webhooks | code | `src/app/api/webhooks/payments/route.ts` | ✅ |
| C5 | Security headers (HSTS, nosniff, DENY framing, referrer, permissions) | code | `next.config.mjs` | ✅ |
| C6 | Real-Postgres test harness (skips in CI) | code | `tests/integration/postgres.finalize.test.ts` | ✅ |
| C7 | Staging smoke script + `smoke:staging` / `test:postgres` scripts | code | `scripts/staging-smoke.mjs`, `package.json` | ✅ |
| C8 | Branch protection doc + required CI gate | code | `.github/BRANCH_PROTECTION.md`, `.github/workflows/ci.yml` | ✅ |
| C9 | Holder analytics SQL aggregation (`holder_analytics` RPC + support indexes) replacing bounded Node-side counting | code | `src/lib/holder-analytics.ts`, `supabase/migrations/20260910000003_*` | ✅ |
| C10 | Analytics session ids: per-tab sessionStorage id in `track()` (privacy-safe; feeds unique-session metrics) | code | `src/lib/analytics.ts` | ✅ |
| C11 | Open-redirect hardening on `/welcome` next param + CTA protocol regression tests | code | `src/app/welcome/page.tsx`, `tests/integration/cta.test.ts` | ✅ |
| C12 | Repository cleanup: PR #1 closed as superseded, stale branches removed, old repo refs updated | code/admin | `.github/BRANCH_PROTECTION.md`, docs | ✅ |

Remaining optional code follow-ups (pick up if time, not blocking launch):
- Add `STAGING_URL` smoke as a required GitHub check against the Cloudflare beta origin. **Implemented** as the separate `Hosted beta smoke` job in `.github/workflows/ci.yml`; add that job to the GitHub branch-protection required-check list after its first run.
- Promote in-memory concurrency tests to run against a throwaway Supabase in CI nightly (needs `SUPABASE_SERVICE_ROLE_KEY` secret).

## Lane C2 — Money-path hardening follow-ups (deep-scan findings, 2026-09-12)

Implemented in this pass (CI-verified: typecheck + 178 unit tests + build green):

| # | Finding | Fix | Files |
|---|---------|-----|-------|
| C2-1 | Refund idempotency key was per-attempt (`claim.claimToken`), so a timeout-after-success followed by a retry minted a fresh key and double-refunded | Deterministic key per payment (`refund:<provider>:<paymentId>`) shared by all attempts; the ledger-level no-retry-on-indeterminate rule (C7-3) is what actually makes this safe on Dodo, which does not document a request key for `POST /refunds` | `src/lib/takeover.ts`, `src/lib/payments.ts` |
| C2-2 | Refund executed via env-selected provider, so a Dodo↔Stripe switch between payment and refund misdirected the refund | `getProviderForEvent(provider)` pins execution to the event's owning provider | `src/lib/payments.ts`, `src/lib/takeover.ts` |
| C2-3 | `setQuoteCheckout` fallback resurrected terminal (expired/stale/cancelled) quotes to `checkout_created` and returned a provider session for a dead quote | Fallback removed; throws `QUOTE_NOT_CHECKOUTABLE:<status>`, route maps to 409 `quote_<status>`; memory adapter mirrors the refusal | `src/lib/repo/supabase.ts`, `src/lib/repo/memory.ts`, `src/app/api/checkout/route.ts` |
| C2-4 | No timeout on Dodo checkout/refund `fetch` — a hung socket held the route and the refund-ledger lease indeterminately | `AbortSignal.timeout(15_000)` on both calls; abort stays on the indeterminate/lease path, never a clean failure | `src/lib/payments.ts` |
| C2-5 | `stale_timestamp` verification failure returned terminal 400: paid money with no sale, no refund, no ledger row | Stale-but-signed deliveries re-verified with the age gate waived (HMAC still enforced) and routed through the normal money pipeline; `webhook_stale_but_signed` alert | `src/lib/payments.ts`, `src/app/api/webhooks/payments/route.ts` |
| C2-6 | `x-real-ip` treated as platform-trusted though client-sendable on edge-bypass paths; garbage strings became limiter buckets | Dropped from trusted set; literal IPv4/IPv6 validation on all IP values; untrusted input collapses to the shared `unknown` bucket | `src/lib/client-ip.ts`, `tests/integration/client-ip.test.ts` |

Still open (owner/provider decisions, NOT code-fixable here): chargeback-keeps-tag policy, auth+capture vs charge-first economics, trademark bulk-reserve + takedown queue, PITR + nightly dumps, DPDP/GDPR delete/export, wallet-balance alerting. See Lane D / INTEGRATION_NOW open items.

## Lane C3 — Money-path hardening + Cloudflare repair (2026-09-13)

CI verified: typecheck + lint + 210 tests + `npm run build` + `npm run cf:build` + real-Postgres suite + 113 browser tests. Hosted smoke re-verified after redeploy; the money-path items still need hosted re-verification before they count as staging-verified.

| # | Finding | Fix | Files |
|---|---------|-----|-------|
| C3-1 | `processSucceededPayment` ran the terminal-quote/expiry/profile/amount refund branches before the sales idempotency lookup. A loser's `stale` write (or a suspension/profile deletion, or a payload variant that drops metadata/amount) made a duplicate delivery of an already-funded payment refund a sale that exists — buyer keeps the tag AND the money. | Resolve the provider payment id against the sales ledger first: an existing sale is a duplicate (matching args) or IDEMPOTENCY_CONFLICT (alert, never refund), including on the missing/unknown-quote paths. Mutation-verified regression tests. | `src/lib/repo/types.ts`, `src/lib/repo/{supabase,memory}.ts`, `src/lib/repo.ts`, `src/lib/takeover.ts` |
| C3-2 | `reconcileRefundProviderEvent` read-then-wrote without a status predicate; a late `refund.failed` could downgrade a settled `succeeded` refund to `manual_review` and invite a double refund. | The UPDATE carries `status <> 'succeeded'`; Postgres re-evaluates it under READ COMMITTED. Forced-interleaving test + negative control in `tests/pg`. | `src/lib/repo/supabase.ts`, `tests/pg/finalize-rpc.test.ts` |
| C3-3 | `markQuoteStatus` could downgrade a consumed quote to stale/expired (audit-state loss; previously a refund vector). | `consumed` is terminal in both adapters. | `src/lib/repo/{supabase,memory}.ts` |
| C3-4 | A duplicate-key race on `sales.provider_payment_id` mapped to `FINALIZE_ERROR`, which the webhook refunds. | `mapFinalizeRpcError` maps 23505 on that key to `IDEMPOTENCY_CONFLICT`; unit-tested. | `src/lib/repo/supabase.ts` |
| C3-5 | `/api/market/pulse` answered a constant `"realtime"` when the server saw Supabase env. Client Realtime-vs-polling is decided from BUILD-time inlined vars; on Cloudflare the runtime server env can disagree, so polling clients froze and live updates silently stopped. | Always compute the composite fingerprint; polling clients get real updates. Test pins "never the frozen constant". | `src/app/api/market/pulse/route.ts` |
| C3-6 | Raw `%` params 500'd `/domain/[domain]` and `/u/[handle]`; reserved domains 500'd their OG image. | `safeDecodeURIComponent`; the OG route skips `getDomain` for ineligible domains and renders an explicit reserved card. | `src/lib/navigation.ts`, `src/app/domain/[domain]/{page,opengraph-image}.tsx`, `src/app/u/[handle]/{page,analytics/page}.tsx` |
| C3-7 | Assorted hardening: profile route lacked the 4 KiB body cap; `CheckoutButton` stayed busy forever on a null `checkoutUrl`; the CTA `host_reserved` message key never matched the route code; `race.mjs` indexed filtered checkouts against unfiltered quotes; ledger totals were presented as all-time over truncated slices. | Fixed with tests where route-testable. | multiple |
| C3-8 | Workers beta served a stale artifact: every prerendered HTML page 500'd with OpenNext's static-to-dynamic error (the session-refresh proxy reads cookies on those routes), and the client bundle had no inlined public Supabase env because `cf:build` ran without it. | All HTML routes `force-dynamic` (client pages behind server wrappers); rebuilt with `NEXT_PUBLIC_*` exported; redeployed. Live: all pages 200, health/db/redis/origin green, smoke now 10/10 after C4-9. `DEPLOY.md §3` documents both traps. | `src/app/{login,welcome,checkout/mock}/**`, legal pages, `DEPLOY.md` |

## Lane C4 — Third deep-scan wave (2026-09-13)

CI verified: typecheck + lint + 218 tests + `npm run build` + real-Postgres suite (15 migrations) + schema equivalence. Hosted migrations applied and privilege-verified via the authenticated Supabase CLI.

| # | Finding | Fix | Files |
|---|---------|-----|-------|
| C4-1 | **The hosted database was missing the entire operator moderation toolkit** (`admin_audit` + all `ops_*` functions), even though `db/ops.sql` is the documented takedown/suspension procedure — so the documented response to a legal request would have failed with "function does not exist". | Applied `20260913000001_operator_tooling.sql` to the hosted project; live query confirms anon/authenticated cannot execute the functions or read the audit table while service_role can. | `supabase/migrations/20260913000001_operator_tooling.sql`, hosted DB |
| C4-2 | Every `finalize_takeover` comparison was NULL-skippable: `x <> NULL` is NULL and an `if` treats NULL as false, so a NULL expected version, amount, or replay amount bypassed the staleness/price/idempotency guards. | `20260913000002_finalize_null_guards.sql` makes each comparison explicit; applied to hosted; three mutation-tested pg cases. | `supabase/migrations/20260913000002_*.sql`, `db/schema.sql`, `tests/pg/finalize-rpc.test.ts` |
| C4-3 | `isIdShaped` accepted 36-char non-UUIDs (all dashes/zeros); the Supabase adapter sent them to `uuid = '----'`, producing unauthenticated 500s on `/takeover/<id>`, `/success/<id>`, `/checkout/return?quote_id=`, and both OG routes. | Strict canonical-UUID regex in the shared guard; unit-tested with malformed 36-char corpus. | `src/lib/repo/shared.ts`, `tests/integration/id-shape.test.ts` |
| C4-4 | The holder profile scanned `listMarket(1000)` per view (1000 rows) and "Currently held" silently dropped tags beyond the market cap. | Direct `listDomainsForHolder` query + `domains(holder_handle, price_cents desc)` index (`20260913000003`). | `src/lib/repo/*`, `src/app/u/[handle]/page.tsx`, migration |
| C4-5 | Sitemap reserved filtering was an N+1 of up to 500 `isReservedInDb` queries per crawler hit (and `listMarket` already filtered). | One cached `listReservedDomains()` read plus the shared `dropReservedRows` filter. | `src/lib/repo/*`, `src/app/sitemap.ts` |
| C4-6 | Telemetry-budget overflow called `buckets.clear()`, resetting the instance-wide counter, so a multi-window flood bought a fresh global Redis allowance each time the map filled. | Evict expired entries, then oldest per-client buckets; the dimension's global counter is preserved. Direct tests. | `src/lib/view-events.ts`, `tests/integration/telemetry-budget.test.ts` |
| C4-7 | `updateProfileExtras` used `.single()`, so a user with no profile row got a thrown PGRST116 (500) instead of the intended `profile_missing` (404). | `.maybeSingle()`. | `src/lib/repo/supabase.ts` |
| C4-8 | Proxy matcher exclusions `api/webhooks`, `api/demo`, `api/market/pulse` were unanchored prefixes that would silently swallow future sibling routes (`/api/demographics`, `/api/market/pulsecheck`). | Trailing `/` for the two subtrees, `$` for the single route; adjacency paths pinned in the matcher test. | `src/proxy.ts`, `tests/integration/proxy-matcher.test.ts` |
| C4-9 | Monitoring gap: the health workflow and smoke suite never fetched an HTML page other than `/`, so the static-to-dynamic outage stayed invisible while liveness/db/redis stayed green. | Health workflow and `smoke:staging` now check all public HTML routes (smoke is 10 checks). | `.github/workflows/staging-health.yml`, `scripts/staging-smoke.mjs`, docs |

## Lane C5 — Display-read and config hardening (2026-09-13)

CI verified: typecheck + lint + 221 tests + build + real-Postgres + schema equivalence + 117 browser tests. Redeployed to the beta (version `1360612b`); live smoke 10/10.

| # | Finding | Fix | Files |
|---|---------|-----|-------|
| C5-1 | Display reads shared the money gate: `getDomain`/`listSalesForDomain` call `requireEligibleDomain` and THROW for reserved tags, so a domain added to the static blocklist after it sold would 500 `/success/<id>` and its OG card and hide the immutable ledger. | New `getDomainForDisplay`; `listSalesForDomain` normalizes instead of requiring eligibility; success page/OG/domain page render a reserved state with the ledger intact. Mutation-tested. | `src/lib/repo/*`, `src/app/success/**`, `src/app/domain/[domain]/page.tsx` |
| C5-2 | The provider/datastore guard was one-directional: the demo provider against the production datastore fell through to `getPaymentProvider()`, which throws → 500 on checkout and every webhook. | `isPaymentConfigConsistent()` used by both routes; mismatch is a clean 503. Unit-tested in a fresh process. | `src/lib/payments.ts`, `src/app/api/{checkout,webhooks/payments}/route.ts` |
| C5-3 | Suspension hid the profile page but not the holder's outbound CTA on the tags they still hold — moderation half-applied, with a live external link left on every tag. | `holderCtaVisible()` suppresses the CTA for suspended holders on tag pages; the handle itself stays visible (ledger truth). | `src/lib/cta.ts`, `src/app/domain/[domain]/page.tsx`, tests |
| C5-4 | Browser suites had no coverage for the reserved/malformed OG paths fixed in C3-6 (which is how they went unnoticed). | `og.spec.ts` now asserts both render PNGs. | `tests/browser/og.spec.ts` |
| C5-5 | README and `.env.example` still described the pre-Cloudflare state (Vercel as the beta origin, integration work already done). | Refreshed to the active beta, current status, and the Cloudflare monitoring path. | `README.md`, `.env.example` |

## Lane C6 — Fourth wave: full-file re-audit (2026-09-13)

CI verified: typecheck + lint + 249 tests + build + 31 pg tests + strengthened schema equivalence + 119 browser tests (120 total, 1 skipped). Hosted migrations `20260913000004`/`20260913000005` applied and verified; beta redeployed and smoke 10/10. A later section records the final deploy version.

| # | Finding | Fix | Files |
|---|---------|-----|-------|
| C6-1 | `POST /api/quotes` threw `input.trim is not a function` outside the error mapping for a non-string `domain` → unauthenticated 500. | Type-check before normalize; 400. Route tests for non-string/missing/valid bodies. | `src/app/api/quotes/route.ts`, `tests/integration/quotes-route.test.ts` |
| C6-2 | `/api/health?check=db|redis` unauthenticated + proxy-exempt; an anonymous loop burns the shared Upstash quota the fail-closed limiter (and the money path) depends on. | 30s cache for deep checks; `ts`-identity test. | `src/app/api/health/route.ts`, `tests/integration/health-analytics.test.ts` |
| C6-3 | The schema depended on the Supabase baseline for USAGE/table privileges; the equivalence check could not see it (both sides equally incomplete), and money/moderation tables lacked an explicit client-role DENY. | `20260913000004_role_grants.sql`: explicit schema USAGE, discovery SELECT, profiles column-only, money/moderation revoke, service_role DML, default privileges. Applied to hosted + verified. pg test with no baseline, mutation-tested. | `supabase/migrations/20260913000004_role_grants.sql`, `db/ops.sql`, `tests/pg/operator-tooling.test.ts` |
| C6-4 | `finalize_takeover`/`holder_analytics` omitted `pg_temp` from `search_path` (no exploitable path today; inconsistent with the other RPCs). | `alter function ... set search_path = public, pg_temp` in the same migration; pg assertion on `proconfig`. | migration, `db/ops.sql`, pg tests |
| C6-5 | The equivalence verifier could false-PASS: no trigger/view/sequence/partitioned-RLS fingerprint; whitespace normalization hid literal changes; a new `db/*.sql` could escape the check. | Added all three dimensions + separate string-literal fingerprints + an unaccounted-file guard; all mutations verified to fail. | `scripts/schema-equivalence.mjs` |
| C6-6 | Regression tests that did not test what they named: local IDEMPOTENCY_CONFLICT test used a different payment id; interleaves could pass without hitting the lock; held-domain race ignored loser codes; the HTTP race printed "no money lost" for failed refunds; no webhook ROUTE test; refund key/provider pinning unasserted; suspended-after-purchase uncovered. | Fixed/added each; mutation-tested the new guards. | `tests/pg/finalize-rpc.test.ts`, `tests/load/race.mjs`, `tests/integration/{webhook-route,duplicate-delivery-safety,dodo}.test.ts` |
| C6-7 | Suspended profiles stayed indexable/sitemapped; a suspended holder's CTA rendered on held tags; receipts/OG ignored the DB blocklist (domain page honoured it). | noindex + one-query sitemap filter; `holderCtaVisible` on tags; receipts/OG use `isDomainReserved`. | `src/app/u/[handle]/page.tsx`, `src/app/sitemap.ts`, `src/app/domain/[domain]/page.tsx`, `src/app/success/**` |
| C6-8 | Always-zero "unique sessions" metric; unlabeled truncated lists; "Most contested tag" measured the holder's own purchases; homepage total unlabeled; terminal quotes said "Finalizing…"; several silent-failure buttons and raw error codes. | Removed/labeled metrics, fixed copy, added try/catch + friendly messages, keyed CTA errors off the response code. | several pages/components |
| C6-9 | Terms §7 promised a post-sale reservation refund with no code path or runbook; Refund Policy said completed takeovers are never refundable; analytics-retention privacy promise unenforced. | Refund Policy now matches Terms; `db/ops.sql` + `DEPLOY.md §7` document the manual provider refund procedure; retention enforcement documented with owner step D5. | `src/app/refunds/page.tsx`, `db/ops.sql`, `DEPLOY.md` |
| C6-10 | Tooling/docs: CI negative test accepted any error; smoke 404 probe was non-fatal; `.dev.vars` unignored; no Node engines pin; `tests/pg` excluded from typecheck; BRANCH_PROTECTION told admins to put test credentials in previews; PROJECT_BLUEPRINT/handoff docs stale. | Exact-422 assertion, bounded CI job, fatal 404 probe, ignores + engines, pg typechecking enabled, docs refreshed. | `.github/**`, `scripts/staging-smoke.mjs`, `.gitignore`, `package.json`, `tsconfig.json`, docs |
| C6-11 | Domain OG card computed `reserved` from the static list only, so a DB-reserved tag unfurled as claimable while `/domain/<tag>` said operator-reserved; non-reserved ineligible inputs advertised "$5 first claim". | Uses `isDomainReserved`; ineligible inputs render "— / not a priced tag". | `src/app/domain/[domain]/opengraph-image.tsx` |
| C6-12 | Sitemap's suspended-handle lookup threw on any profiles error → `/sitemap.xml` 500 for every crawler; one unbounded `.in()` query. | Chunked (200/query) and lenient like the reserved display cache; regression test. | `src/lib/repo/supabase.ts`, `tests/integration/sitemap.test.ts` |
| C6-13 | `client-ip` accepted colon-garbage (`1:2:3`, `abc:def`, `1.2.3.4:`) as an IPv6 literal. | Real IPv6/IPv4-mapped validation + corpus test. | `src/lib/client-ip.ts`, `tests/integration/client-ip.test.ts` |
| C6-14 | Telemetry eviction preserved only the checked dimension's global counter; a flood on one dimension could reset the other's instance-wide allowance. | Preserve every `*:__all__` bucket; test. | `src/lib/view-events.ts`, `tests/integration/telemetry-budget.test.ts` |
| C6-15 | Blanket `23505 → IDEMPOTENCY_CONFLICT` would misclassify a future unique constraint and skip a refund; `reconcileRefundProviderEvent` didn't update `provider_event_id` like the memory adapter. | Constrain to the `sales.provider_payment_id` constraint; add the event id on the update path; tests. | `src/lib/repo/supabase.ts`, `tests/integration/finalize-error-mapping.test.ts` |
| C6-16 | CSS: bio textarea unstyled and below 16px (iOS zoom); history-ledger desktop grid had four tracks for five cells; `.btn-block` hard-clipped wrapped labels. | textarea shares input styling; five tracks; wrap instead of clip. | `src/app/globals.css` |
| C6-17 | Browser coverage could pass vacuously: CSP probe ignored 5xx, the privacy test used a nonexistent handle, brand/legal assertions were negative-only, malformed-percent pages untested. | Status check, real non-owned seeded profile, positive assertions, malformed-param test. | `tests/browser/*` |
| C6-18 | A `cf:build` that reused a dirty `.next` from a differently-configured `npm run build` produced a Worker that exceeded Cloudflare's CPU limit (error 1102) on every page render; health/pulse stayed green. | Clean rebuild restored service; `precf:build` now wipes `.next`/`.open-next` before every Worker build; documented in DEPLOY §3 and the incident recorded in INTEGRATION_NOW. | `package.json`, `DEPLOY.md` |

## Lane C7 — Fifth wave: payment-outcome exclusion (2026-09-13)

CI verified: typecheck + lint + 251 tests + 31 pg tests + schema equivalence + 119 browser tests. Hosted `20260913000005` applied and verified; beta `c906abf8`, smoke 10/10.

| # | Finding | Fix | Files |
|---|---------|-----|-------|
| C7-1 | **CRITICAL — one payment id could produce two outcomes.** `finalize_takeover` checked only `sales`, `claim_refund_attempt` only `refunds`. A payment refunded by event E1 (amount re-derived differently; the refund branch does not make the quote terminal) could fund a takeover on event E2, and a racing claim could refund a funded sale. Buyer keeps the tag AND the money. | Both sides take a per-payment advisory lock and refuse when the other's outcome exists: finalize → `PAYMENT_REFUNDING`; claim → `already_finalized`. Memory mirror, route handling, and forced-interleaving pg tests in both orders (mutation-verified). | `supabase/migrations/20260913000005_*.sql`, `db/schema*.sql`, `src/lib/repo/*`, `src/lib/takeover.ts`, `src/app/api/webhooks/payments/route.ts`, tests |
| C7-2 | `reconcileRefundProviderEvent` (TS read-then-write) inserted/updated refund rows without the payment lock, so a dashboard refund event could race a finalization. | Moved to `reconcile_refund_event` SQL RPC on the same advisory lock, with FOR UPDATE and the no-downgrade rule in SQL. `anon`/`authenticated` denied, enforced by a pg test enumerating every privileged RPC. | migration, `src/lib/repo/supabase.ts`, tests/pg |
| C7-3 | Dodo refund timeout/abort/unreadable-200 may have executed the refund, but the ledger marked it retryable (`failed`); Dodo does not document an idempotency header on `POST /refunds`, so a retry could double-refund. | `RefundResult.indeterminate`; Dodo classifies fetch/abort/unreadable-body as indeterminate, and the ledger parks it in `manual_review` (terminal). Provider-level test matrix. | `src/lib/payments.ts`, `src/lib/takeover.ts`, `tests/integration/dodo.test.ts`, `payment-outcome-exclusion.test.ts` |
| C7-4 | A `received` payment_events row was acknowledged as in-progress forever if the first delivery crashed or its terminal status write failed — a paid payment permanently unprocessed. | `processed_at` exposed; rows older than 15 min re-enter processing with a `webhook_retry_stale_received` alert. Helper + tests. | `src/lib/webhook-retry.ts`, route, repo types, tests |
| C7-5 | The enforced CSP was middleware-only, so proxy-excluded routes carried only Report-Only — and any future HTML route added to the exclusions would silently lose it. | Enforced CSP moved to `next.config.mjs` headers (all routes); `x-powered-by` disabled; verified live on matched and excluded paths. | `next.config.mjs`, `src/proxy.ts` |
| C7-6 | `finalize_takeover`'s reserved check ran before the domain lock; memory finalize accepted empty identifiers; health cache had no per-key guard. | Reserved check moved after the lock; memory validation mirrored; per-key cache test added. | migration, `src/lib/repo/memory.ts`, tests |
| C7-7 | Doc drift: Track A/C and monitoring still named Vercel as current; migrations README recommended `db push` for the hosted project; `PRICED_CREDITS_ENABLED` documented as an existing flag; wrong cross-references; skill snippet used a literal `file`. | Corrected across INTEGRATION_NOW/LAUNCH_CHECKLIST/README/DEPLOY/migrations README/CREDITS/.env.example/skill. | docs |

## Lane C8 — Sixth wave: exclusion refinements (2026-09-13)

CI verified: typecheck + lint + 258 tests + 35 pg tests + schema equivalence + 119 browser tests. Hosted `20260913000006` applied and verified; beta `baae4059`, smoke 10/10.

| # | Finding | Fix | Files |
|---|---------|-----|-------|
| C8-1 | The `refund_after_sale` alert raced the finalization: the route's sale lookup ran before reconcile, outside the advisory lock, so a concurrent sale commit meant the contradiction was recorded with no alert. | `reconcile_refund_event` now returns `(status, sale_exists)` computed under the same lock; the route alerts on the returned verdict. Forced-interleaving pg test. | migration 06, `db/schema-extended.sql`, `src/lib/repo/*`, route, tests |
| C8-2 | Any refund row blocked finalize, so a definitively failed refund (provider answered, nothing moved) parked the payment with no automatic path. | Finalize blocks only on live intents (`attempting`/`succeeded`/`manual_review`); `failed` no longer blocks and the advisory lock keeps the check-vs-retry race atomic. Memory mirror + status-matrix pg test. | migration 06, `db/schema.sql`, `src/lib/repo/memory.ts`, tests |
| C8-3 | Coverage: no route-level refund event test, no reconcile-vs-finalize interleave, no failed-status matrix, no mapping test for `PAYMENT_REFUNDING`, no reconcile verdict test. | Added all five; skill catalogue updated with the two new defect classes. | tests, `.claude/skills/money-path-review/SKILL.md` |

## Lane D — Go-live gates (after B is green)

| # | Task | Type | Notes |
|---|------|------|-------|
| D1 | Professional **legal review** of `terms` / `privacy` / `refunds` + Dodo product-classification confirmation | owner | Spec §49 / §21 — strongly advised before real money |
| D2 | Swap Dodo **test → live** keys + webhook secret; switch `DODO_PAYMENTS_MODE=live` in Production only | owner | Keep Preview on test keys |
| D3 | **Closed beta** with 10–20 people proving repeat competition (spec §77) | owner+verify | Watch the Cloudflare live tail (`npx wrangler tail priced`) for `takeover_succeeded`, `refund_failed`, etc. |
| D4 | Public announcement | owner | Only after §76 gate + D1–D3 |
| D5 | **Analytics retention enforcement** — add repo secrets `SUPABASE_PROJECT_URL` + `SUPABASE_SERVICE_ROLE_KEY` and get `.github/workflows/analytics-retention.yml` merged to the default branch | verify | **Staging verified**: secrets are configured, the workflow is merged to `main`, and manual run `34771269757` completed successfully against the hosted Supabase project (`0` expired rows deleted). `DEPLOY.md §9` |
| D6 | **Post-sale reservation refunds** — decide whether the operator refund on a held-tag reservation becomes tooling or stays a documented manual provider refund | owner | Terms §7 promises the last payment back; `db/ops.sql` documents the manual query/refund/audit procedure. No automated money path exists by design |

## 2026-09-17 sandbox reconciliation

The three previously blocked disposable stale-race refunds were completed in
Dodo Test Mode after sandbox top-up checkouts. Three corresponding hosted
refund ledger rows are now `succeeded`; seven older provider-
`PAYMENT_ALREADY_REFUNDED` `unknown_quote` rows remain `manual_review`, and one
older row is `failed` with the same explicit provider error, pending an
authoritative signed refund event. The 25-way hosted HTTP/payment race remains
**External provider blocked** because its 24 stale refunds would require approximately `$144` of
Test Mode wallet capacity at the observed debit per refund.

## 2026-09-18 hosted payment race reconciliation

The fresh disposable tag `dodo-http-race-20260918-c.com` accepted 25
successful Dodo Test Mode provider payments. The hosted application and
Supabase ledger recorded exactly one consumed quote/sale (`@harshit`, `$5`,
version 1), eight stale quotes, and sixteen quotes that expired at the
five-minute TTL while the eight-per-window quote limiter was respected. The
24 non-winning payments each have a `succeeded` Dodo refund-ledger row,
totaling `$120.00`, and none has a sale. The refreshed Dodo Test Mode balance
was `$64.13` after the one previously wallet-blocked legacy payment was also
fully refunded from the dashboard and is now `$66.67` after the later
terminal-quote payment/refund check. The seven other legacy rows have explicit
`PAYMENT_ALREADY_REFUNDED` provider responses and no sale; they remain
bookkeeping-only `manual_review` rows until signed provider refund events
arrive.

A separate hosted terminal-quote check on
`dodo-http-terminal-20260918.com` paid one quote to `consumed` and then paid a
competing quote through its already-created Dodo Test Mode checkout. The
competing return was `stale`, the `$5.00` refund ledger row became `succeeded`,
and no second sale was created. This covers the terminal-quote payment/refund
race through the hosted checkout and signed webhook path.

This is **Staging verified (partial)** for the hosted 25-payment/refund path
and exactly-once finalization. The strict same-version 25-way timing gate is
still **External provider blocked** until the run can use distinct signed-in
challengers or an equivalent controlled setup that keeps every quote inside
the five-minute TTL. Do not weaken the deployed rate limits or quote rules.

## Quick start for a new agent

1. Read `LAUNCH_CHECKLIST.md` (strict word statuses: Implemented / CI verified / Staging verified / Owner blocked / External provider blocked) and `DEPLOY.md`.
2. Pick a lane above. Lanes A/B are sequential; Lane C is already done.
3. For code changes: `npm run typecheck && npm run lint && npm run test && npm run build` must stay green. Don't add deps without need.
4. Owner steps need credentials — don't mock them. Mark them Owner blocked in the checklist until actually done.
