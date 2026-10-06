# Launch Checklist — Priced

One authoritative progress file (§41). Statuses are strict:

- **Implemented** — code exists in the repo
- **Locally verified** — ran on a developer machine
- **CI verified** — runs on every push to `main` via `.github/workflows/ci.yml`
- **Staging verified** — ran against the real preview environment with real services
- **Production verified** — ran against production with live credentials
- **Owner blocked** — requires accounts, credentials, legal, or humans; exact action documented
- **Deferred** — deliberately not for launch

Nothing is marked beyond the level actually evidenced.

Active beta hosting (2026-09-30): Cloudflare Worker `priced` at
`https://priced.pricedapp.workers.dev`. The Vercel project and
`https://internet-price-tag.vercel.app` are rollback/reference only. Older
Vercel references below describe the prior deployment unless superseded by
`INTEGRATION_NOW.md`.

Latest hostname migration (2026-09-30): the Cloudflare account namespace is
`pricedapp`, and both account Workers moved to that namespace. Dodo Test Mode
webhooks now target the new Priced URL; a signed duplicate event returned HTTP
200, and the 10-check staging smoke passed. Supabase Auth still needs the new
Site URL and callback allowlist before Google sign-in can be verified on this
host (**Owner blocked**).

Latest launch-hardening deploy (2026-10-03): PR #78 merged to `main` as
`b5204ff` and the hardened build was deployed to Worker `priced` as version
`b9377c49-52cd-4057-975e-3beba99c6a1e`, replacing the prior live version
`83d0fcc0` that still ran the `next` `16.3.4` build inside the `next/og`
advisory range. Hosted re-verification: origin `ok`, `smoke:staging` 11/11,
`?check=db` reports `supabase`, the OG routes return PNGs, and the unsigned
webhook probe is rejected HTTP 400. The new alert/DR workflows are merged but
still skip until the owner sets their repository secrets.

Latest sandbox reconciliation (2026-09-18): Dodo Test Mode successfully
completed the previously wallet-blocked stale-payment refunds after
disposable sandbox top-ups. Dodo's signed replay of missing historical
`refund.succeeded` events then reconciled the remaining legacy rows; the
hosted Supabase audit now has zero Dodo refund rows in `manual_review` or
`failed`. No customer-facing sale is associated with those refunds.
An earlier 25-payment hosted batch is **Staging verified (partial)**: one
takeover finalized and 24 refund rows succeeded; 16 quotes expired during
the five-minute TTL and 8 were stale. A clean same-version 25-way race is
now documented below as **Staging verified**; this earlier batch was limited by
the deployed eight-per-window quote limiter and five-minute TTL, not by missing
wallet capacity.
A separate two-quote hosted terminal-quote check also paid the winner and then
paid the competing quote through its already-created checkout; the latter
returned `stale`, and its `$5.00` refund ledger row became `succeeded` with no
second sale.

Earlier prepared-challenger payment completion (2026-09-19): all 25 prepared
Dodo Test Mode checkout sessions were submitted for a disposable same-version
domain. Exactly one quote was consumed and recorded a `$5.00` sale; the other
24 quotes expired because sequential browser submission crossed the five-minute
TTL. Dodo's Test Mode dashboard shows successful full refunds for all 24
non-winning payments (21 tax-inclusive `$5.90` refunds and 3 `$5.00` refunds).
This is additional **Staging verified (partial)** payment/refund evidence; it
does not clear the clean same-version timing gate because the 24 losing quotes
were no longer live when paid.

Latest clean same-version payment completion (2026-09-19): all 25 Dodo Test
Mode checkout sessions for a disposable tag were submitted through four
authenticated challenger accounts while their quotes remained live. Exactly
one quote was consumed and recorded a `$5.00` sale, 24 quotes became `stale`,
and zero quotes expired. Dodo shows 24 successful full refunds for the
non-winning payments, each with the tax-inclusive `$5.90` provider total. The
strict same-version 25-way timing gate is now **Staging verified**; no limiter,
TTL, amount, webhook, or concurrency control was weakened.

Previous-origin browser beta pass (2026-09-18; predates the current hostname): public routes, holder profile,
analytics, receipt/share surface, search, quote confirmation, Dodo checkout,
checkout cancellation, and a real Dodo Test Mode declined-card path were
exercised on the stable Cloudflare origin. The declined payment produced a
signed `payment.failed` delivery accepted with HTTP 200, left the tag
unclaimed, and did not change the `$66.67` Test Mode balance. The local browser
suite passed 119 tests with 1 intentional skip on desktop and mobile; hosted
browser console errors/warnings were zero.

Latest cleanup and release audit (2026-09-19): the duplicate untracked
`.agents/` copy and regenerated build/test artifacts were removed from the
worktree. Supabase had no unclaimed domains; sold sandbox domains and all
immutable sales/payment/refund evidence were preserved. Exactly 25 expired
quote rows with no checkout/payment id were removed. Typecheck, lint, full
tests, production build, Cloudflare build, hosted health, and the 10-check
staging smoke are green.

## Product

| Item | Status | Evidence |
|---|---|---|
| Homepage/market, search, market-cap metric, discovery (Most Contested, Fastest Rising, Newly Claimed) | CI verified | `tests/browser/market.spec.ts`, `responsive.spec.ts`; discovery logic unit-tested in `tests/integration/discovery.test.ts` |
| Domain pages: holder, price, transparent math, provenance history (prev holder, deltas, first claims) | CI verified | `tests/browser/market.spec.ts`, `loop.spec.ts` |
| Takeover flow: quote (5-min TTL) → confirm → checkout → atomic finalization | CI verified | `tests/integration/*`, `tests/browser/loop.spec.ts` |
| Success receipt + share artifacts (X, copy, native share, `?via=` attribution) | CI verified | `tests/browser/loop.spec.ts`, `og.spec.ts` |
| Priced branding everywhere public | CI verified | `tests/browser/brand.spec.ts` asserts the old name is absent from every surface |
| UI/device review at 375/430/768/laptop/large | Staging verified for the hosted desktop browser pass; CI verified for the 375/430/768 viewports; real-device check Owner blocked | `tests/browser/responsive.spec.ts`; hosted beta review covered homepage, legal pages, login entry, domain, profile, analytics, and receipt/share routes on 2026-09-18; a real-device eyeball pass remains owner work |
| OG cards (domain + receipt, Priced branded, prev holder + next price) | CI verified as routes | PNG rendering + headers asserted in `og.spec.ts`; X card validator check is owner-gated |

## Market correctness (money)

| Item | Status | Evidence |
|---|---|---|
| Integer-cent pricing, pay-what-you-want offers with server-enforced minimum (`$5` first claim; current price + max(`$5`, `1%`) takeover floor) | CI verified | `src/lib/game.test.ts`, `tests/integration/pay-what-you-want.test.ts`, `src/components/TakeoverCTA.tsx` |
| Version-checked, row-locked atomic `finalize_takeover` RPC | Staging verified | Hosted authenticated-CLI database races produced exactly one winner and `STALE_QUOTE` losers at 10 and 25 requests; the real Supabase REST/service-role harness passed all 8 tests, including race, stale-version, idempotency, wrong-amount, self-takeover, and reserved-domain cases. Dockerized `tests/pg/finalize-rpc.test.ts` remains CI-green. |
| Immutable sales history (append-only) | CI verified | RPC inserts only; `db/ops.sql` documents correction procedure |
| In-memory mirror correctness (demo) | CI verified | `tests/integration/concurrency.test.ts` |
| Idempotent webhook handling (event + payment id), durable stale-quote refunds | CI verified | `tests/integration/webhook-safety.test.ts`, `dodo.test.ts`; refund ledger caps automatic attempts and parks uncertain failures for manual review |

## Payments (Dodo primary, Stripe adapter retained)

| Item | Status | Evidence |
|---|---|---|
| Dodo provider: PWYW checkout, Standard-Webhooks verify, refunds | Implemented; CI-verified logic | `tests/integration/dodo.test.ts` (network stubbed) |
| Dodo permission check for symbolic-status product | Implemented | Owner confirmed Dodo product verification/approval; do not reopen unless Dodo requests it |
| Dodo sandbox matrix (success/fail/cancel/duplicate/stale/simultaneous/refund-failure/missing-metadata/wrong-amount/outage) | Staging verified (partial); clean 25-way same-version timing race now Staging verified | Real Test Mode success, declined payment, signed webhook acceptance, duplicate-event replay/idempotency, provider replay of a successful event with a new HTTP 200 delivery, synthetic provider `payment.failed` and `payment.cancelled` delivery with HTTP 200, a real customer-cancellation state transition with `payment.cancelled` delivered HTTP 200, the fail-closed synthetic missing-metadata/refund-failure path with repeatable HTTP 500 retry behavior, a real missing-metadata payment with successful full refund and no matching sale, cancelled-checkout UI behavior, quote consumption, atomic finalization, Dodo tax-inclusive amount handling, hosted stale/wrong-amount refunds, a hosted terminal-quote payment/refund race, a clean same-version 25-payment race with exactly one sale, 24 stale quotes, zero expiries, and 24 successful full refunds, and the 2026-09-18 stale-signed HMAC/duplicate/forged-signature probe are verified on the stable beta origin. The deployed refund path now fails closed on Dodo `pending`/`review` responses and reconciles signed `refund.succeeded`/`refund.failed` events; the Test Mode endpoint subscribes to all 12 required events. The provider-outage path is also Staging verified: a temporary invalid Dodo base URL returned `502 checkout_failed` before provider payment creation, then the override was removed and normal health/smoke checks passed. Procedure: `DEPLOY.md` §4. |
| Live Dodo configuration | Owner blocked | DEPLOY.md §6 |

## Infrastructure

| Item | Status | Evidence |
|---|---|---|
| Supabase project + migrations + auth + Realtime + backups | Staging verified on the previous hostname; Owner blocked for new-host Auth redirect and provider-blocked for managed backups | Existing Priced project and hosted-hardening migrations are the source of truth; Google login, welcome, `@harshit`, database, Realtime, and the isolated restore were verified on the previous hostname. The new origin `https://priced.pricedapp.workers.dev` is not yet in Supabase's Site URL/redirect allowlist, so sign-in must be re-verified after owner dashboard access. Supabase Free Plan does not include managed project backups; PITR remains off. See `INTEGRATION_NOW.md`. |
| Real-Postgres RPC concurrency (10 + 25 racers) | Staging verified | Using an authenticated Supabase CLI database login and bounded PostgreSQL pool, hosted 10-way first-claim concurrency produced exactly 1 `OK`/9 `STALE_QUOTE`, and hosted 25-way held-domain concurrency produced exactly 1 `OK`/24 `STALE_QUOTE`; final states were version 1/price 500/sales 1 and version 2/price 1000/sales 2. The real REST/service-role `tests/integration/postgres.finalize.test.ts` harness also passed all 8 tests with the protected key held transiently in memory. Test rows were removed. |
| Upstash Redis + distributed rate limits | Staging verified | Free-tier database `priced-beta-redis` is created in the new Upstash account (`us-west-1`); REST URL/token are configured only in the active Cloudflare Worker. A clean concurrent hosted run verified handle user/IP `5/15`, profile user `10`, quote user/IP/domain/user+domain `30/60/30/8`, and checkout user/IP `20/30`: the next request in each burst returned `429 rate_limited` with no 5xx. Disposable Auth users, profiles, and quotes were removed; existing `promptpay-staging-redis` was left untouched. |
| Cloudflare Worker beta deployment | Staging verified; Owner blocked for new-host Auth | Worker `priced` serves `https://priced.pricedapp.workers.dev`. On 2026-09-30, the new-origin liveness, Supabase, Redis, origin, all public HTML routes, and 10-check staging smoke passed; a signed duplicate Dodo Test Mode event reached the new webhook and returned HTTP 200. The full Google Auth and checkout/browser journey was verified on the previous hostname and must be repeated after the Supabase Site URL/redirect update. On 2026-09-13 a stale artifact (prerendered pages 500ing with OpenNext's static-to-dynamic error, client bundle missing the inlined public Supabase env) was repaired and redeployed: all public HTML routes return 200, custom 404 renders, health/db/redis/origin are green, and the 10-check smoke passes (including every public HTML route). On 2026-10-03 the launch-hardening build from `main` (`b5204ff`) was deployed as version `b9377c49-52cd-4057-975e-3beba99c6a1e`, retiring the `next` `16.3.4` build: hosted origin check `ok`, smoke 11/11, DB `supabase`, OG routes PNG, unsigned webhook 400. |
| Vercel project rename `internet-price-tag` → `priced` | Implemented | Existing project renamed through the authenticated Vercel CLI; project id preserved and production alias remains `https://internet-price-tag.vercel.app` |
| Env separation (Local/Preview/Production) | Implemented | Matrix in `.env.example`; active Cloudflare Worker holds beta secrets, while ordinary previews remain secret-free/demo-only. |
| Monitoring/alerts (error-event list, uptime, 5xx rate) | Implemented (app-side `ALERT_WEBHOOK_URL` sink + scheduled ledger check + free uptime workflow); Owner step: set the alert-URL secret | DEPLOY.md §8: exact event queries + uptime endpoints. `src/lib/logger.ts` forwards every error-level event to `ALERT_WEBHOOK_URL` (dependency-free, works on Workers, secret/PII keys stripped). `.github/workflows/money-alerts.yml` scans the hosted ledger every 30 min and opens/updates a `money-alert` issue. `.github/workflows/staging-health.yml` checks liveness, Supabase, Redis, origin, every public HTML route, and webhook reachability every 15 minutes; `.github/workflows/ci.yml` has a separate `Hosted beta smoke` status check. Cloudflare live tail remains available for diagnostics. |
| Health endpoint (liveness + `?check=db` readiness) | CI verified | `tests/integration/health-analytics.test.ts` + CI smoke step |

## Holder value layer

| Item | Status | Evidence |
|---|---|---|
| Profiles: bio, CTA, held/previously-held, takeover history, stats | CI verified | `tests/integration/profile.test.ts`, `tests/browser/profile.spec.ts` |
| CTA safety (https-only, protocol rejection, noopener noreferrer nofollow, non-ownership framing) | CI verified | `tests/integration/cta.test.ts` incl. dangerous-protocol regression; WHATWG normalization safe (stores canonical URL) |
| Holder analytics `/u/[handle]/analytics` (owner-only) | Staging verified | Hosted analytics show real tag views, profile views, and share visits through the `holder_analytics` RPC; owner-only route and empty states remain CI-tested |
| Per-tab session ids for unique-visitor counts | Implemented; Locally verified | `src/lib/analytics.ts` sessionStorage id now sent by `track()`; PG-tested distinct-session counting in `holder_analytics` RPC |

## Safety & security

| Item | Status | Evidence |
|---|---|---|
| Reserved domains (static + DB), enforced at quote + inside RPC | CI verified | `tests/pg/finalize-rpc.test.ts` (reserved-domain rollback) |
| Suspension, self-takeover, IDN/punycode, IP/localhost rejection | CI verified | `src/lib/domains.test.ts`, `game.test.ts`, PG suite |
| Rate limits (quote/checkout/handle/demo-sign, user+IP+domain layers) | CI verified | `tests/integration/ratelimit.test.ts` |
| Turnstile (fail-closed when configured) | CI verified | `src/lib/turnstile.test.ts` |
| Open-redirect guards (callback, welcome, handle) | CI verified | `src/lib/navigation.ts`, `tests/integration/navigation.test.ts`, `tests/integration/cta.test.ts`; external, scheme-relative, encoded-separator, and dot-segment traversal cases are covered |
| JSON-only CSRF guards on all money/identity routes | CI verified | health-analytics tests assert 415; routes enumerated in security review |
| Security headers (HSTS, nosniff, DENY, referrer, permissions) and direct RPC denial | Staging verified | Production header check confirms HSTS, `nosniff`, `DENY`, strict referrer, and permissions headers; anonymous Supabase REST calls to `finalize_takeover` and `holder_analytics` both returned HTTP 401. |
| Priced Credits OFF (no read/write path, no UI, no flag) | Verified by absence | `grep credit_ledger src/` → no request path; `grep PRICED_CREDITS src/` → no flag exists (docs/CREDITS.md marks it planned) |
| Analytics privacy (PII strip, no raw webhook bodies, retention ENFORCEMENT) | Staging verified | Route tests plus the merged daily workflow; repository secrets are configured and manual run `34771269757` completed successfully against hosted Supabase (`0` expired rows deleted). DEPLOY.md §9, BACKLOG D5 |

## Trust

| Item | Status |
|---|---|
| Terms/Privacy/Refunds copy (plain-language, non-ownership distinction and support email) | Implemented; professional review Owner blocked pending operator identity/address, minor-purchase capacity/age policy, grievance contact, legal classification, and tax/privacy review (BACKLOG.md D1). Owner currently wants under-18 purchases; app has no age gate. |
| Dodo product-classification confirmation | Implemented (owner-confirmed; see `AGENTS.md` and `INTEGRATION_NOW.md`) |

## Documentation

| Item | Status |
|---|---|
| PROJECT_BLUEPRINT reflects reality (current state, not plan) | Implemented (this pass) |
| DEPLOY runbooks (Cloudflare deploy/build env trap, alerts, retention, operator refunds) | Implemented |
| BACKLOG aligned with this file | Implemented |
| `.env.example` full audit + environment matrix | Implemented |
| No `[ ]` items describing existing features | Implemented |

## Owner gates remaining (in order — exact actions in DEPLOY.md)

1. **Supabase/Auth** (§1): log into the existing Supabase dashboard and set Site URL to `https://priced.pricedapp.workers.dev`; add `https://priced.pricedapp.workers.dev/auth/callback` to the redirect allowlist while retaining the Vercel rollback callback if needed. Then verify Google OAuth, callback, welcome, logout/re-login, and handle creation on the new origin. Previous-origin auth, Realtime, database concurrency, and restore checks remain verified. Managed backups/PITR remain unavailable on the Free Plan.
2. **Sandbox gate** (§4/B1): the clean hosted same-version 25-payment race is now **Staging verified** with exactly one takeover, 24 stale quotes, zero expired quotes, and 24 successful full refund-ledger rows. The deployed eight-per-window limiter and five-minute TTL were preserved. The provider-outage case is also Staging verified, and the normal deployment has a passing `npm run smoke:staging` result. The remaining payment-matrix items are the owner/provider-gated cases documented in `BACKLOG.md` and `DEPLOY.md`.
3. **Monitoring** (§8/A8): set the `ALERT_WEBHOOK_URL` Worker secret (Slack/Discord/generic collector) to switch on real-time error alerting. The scheduled ledger backstop `.github/workflows/money-alerts.yml` is now operational: the `SUPABASE_PROJECT_URL` and `SUPABASE_SERVICE_ROLE_KEY` repository secrets already exist (added 2026-09-13 for analytics retention), and a workflow_dispatch proved it reads the hosted ledger and files/updates the `money-alert` issue. Add an external uptime check if desired; Vercel Hobby's `Add Drain`/`Add Rule`/`Add Webhook` controls were disabled and apply only to the rollback deployment.
4. **Backup/recovery**: the documented logical dump and isolated restore procedure is Staging verified, and `.github/workflows/backup.yml` now takes a **daily** logical dump (`pg_dump` via the `postgres:17` image) and uploads it as a 30-day artifact — set the `SUPABASE_DB_URL` secret to enable it. Supabase Free Plan has no managed project backups; do not enable PITR during the free beta phase. Managed backups/PITR remain required before real-money production.
5. **Legal review (D1; Owner blocked):** Indian counsel must assess whether paid competitive position-taking with outbound business links falls within the Promotion and Regulation of Online Gaming Act, 2025 and its 2026 Rules; review minor contract capacity and DPDP child-data consent/tracking rules; review Consumer Protection (E-Commerce) Rules applicability and disclosures, operator legal name/address, grievance-officer designation and response process, buyer geography, privacy/data transfers, GST/invoicing, and Dodo terms. The owner supplied `social.official.me@gmail.com` as the support email; this does not establish the legal seller identity or satisfy any required officer designation. Keep Dodo in Test Mode until written classification advice and launch documents are complete.
6. **Live keys** (D2): swap to live Dodo config in Production only after every sandbox gate is green and plan compliance is reviewed.
7. **Closed beta** (D3): 10–20 people; watch `takeover_succeeded`, `refund_failed`, and share visits; measure repeat-challenge rate (§35 metrics list).
8. **Public launch** only after §37 gate is fully green.

## Beta measurement plan (§35)

Track via existing `analytics_events` (all real, SQL-counted):
`domain_searched → domain_opened → takeover_clicked → quote_created → checkout_started → payment_succeeded → takeover_succeeded → share_clicked → share_visit → (challenger) takeover_clicked…`

The one number that matters: repeat takeover rate — share of takeovers whose
buyer previously arrived via a `share_visit`. `takeover_succeeded` is now
persisted server-side and is **Staging verified** on the active beta. A true
repeat-takeover query remains deferred until share attribution is explicit:
the current server-rendered `share_visit` sink is intentionally anonymous, so
the metric must not infer buyer attribution from a domain/time coincidence.

## 2026-09-18 hosted payment reconciliation

The fresh `dodo-http-race-20260918-c.com` batch submitted 25 successful Dodo
Test Mode payments. Supabase recorded one consumed quote/sale at `$5.00`,
eight stale quotes, and sixteen expired quotes. All 24 non-winning payment
IDs have succeeded Dodo refund-ledger rows totaling `$120.00`; no refunded
payment created a sale. The final legacy wallet-blocked refund was also
completed in Dodo Test Mode, and the balance after settlement was `$64.13`.
At the time of this ledger snapshot, seven older rows still had explicit
`PAYMENT_ALREADY_REFUNDED` responses and no sale. Dodo's subsequent signed
replay of missing `refund.succeeded` events reconciled those rows; the current
audit is recorded at the top of this checklist and returns zero unresolved
Dodo refund rows.
This closes the wallet-funding issue for the exercised refund set, but the
strict same-version 25-way timing gate stays **External provider blocked**
until 25 quotes can be paid before the five-minute TTL with valid distinct
challengers or an equivalent controlled provider test.
A separate hosted terminal-quote check on
`dodo-http-terminal-20260918.com` settled one winner and one competing
payment; the competing return was `stale`, its refund ledger row was
`succeeded`, and no second sale existed.
The Dodo Test Mode balance is now `$66.67` after this additional payment and
refund activity.
