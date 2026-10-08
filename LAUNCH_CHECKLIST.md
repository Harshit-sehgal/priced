# Launch Checklist — Priced

One authoritative progress file (§41). Statuses are strict:

- **Implemented** — code exists in the repo
- **Locally verified** — ran on a developer machine
- **CI verified** — runs on every push to `main` via `.github/workflows/ci.yml`
- **Staging verified** — ran against the real hosted beta/staging environment with real services
- **Production verified** — ran against production with live credentials
- **Owner blocked** — verification awaits an owner action, credential, or human; status only
- **Deferred** — deliberately outside current scope

Nothing is marked beyond the level actually evidenced.

The owner removed repository launch gates on 2026-10-09. Status entries
record verification only; they are not release prerequisites. This does
not change applicable law, provider terms, or payment safeguards. The
2026-10-09 Live cutover remains incomplete: the Live key and product are
prepared, but the key and signing secret have not been installed in Cloudflare,
and the Live webhook still points to the Vercel rollback URL. See
`INTEGRATION_NOW.md` for evidence.

## Current beta snapshot — 2026-10-09

- Worker `priced` is on version
  `ae0ccfaa-75c2-45d4-a124-be66a9f75b81`, deployed after PR #90 merged on
  2026-10-09. Read-only liveness, database, Redis, and origin checks returned
  healthy responses; `/`, `/login`, `/about`, `/terms`, `/privacy`, and
  `/refunds` returned HTTP 200. No checkout, payment, takeover, or analytics
  event was created during deployment verification.
- PR #90's current-holder share gate is merged and deployed. It is CI verified;
  hosted signed-in holder/non-holder visibility was not independently checked.
- PR #83 copy and age-gate changes are deployed. The age dialog was hosted-UI
  verified, but no age attestation or Dodo checkout was submitted.
- Existing-account Google OAuth works on the active origin. Fresh-account
  welcome/handle creation still needs a human verification pass.
- The owner-approved 2026-10-08 sandbox reset left the market tables empty at
  completion, with all 11 Auth users/profiles retained. At a later read-only
  check on 2026-10-09, the public market showed `claude.dev` (`@harshit`, `$15`)
  and `claude.com` (`@harshit`, `$5`), total `$20`. Dodo Test Mode showed recent
  `$15.00` and `$5.90` payments on 8 Oct that align by amount with those offers;
  exact payment metadata was not inspected. Dodo Live showed no payments. No
  new deletion occurred during this check; no backup is available, and Dodo's
  Test records remain. The owner was asked whether to purge or keep the current
  rows. The immutable-ledger rule remains in force pending that direction.
- `ALERT_WEBHOOK_URL` is absent from Worker secrets. `SUPABASE_DB_URL` is
  absent from repository and environment secret lists. The repository is
  public, so the backup workflow now skips raw database artifacts until a
  private or encrypted destination is implemented. GitHub already requires
  `verify` and `Hosted beta smoke`.
- Dodo's Live dashboard says payments are active; Product Information,
  Personal Information, and Bank Verification are approved. The Live takeover
  product `pdt_0NnJBiDoKwxHCue0tPoZP` preview has Pay What You Want with a
  `$5.00` minimum. A restricted Live key is staged in Dodo for owner transfer;
  it has not been installed in Cloudflare. The enabled Live webhook still
  points to the Vercel rollback URL and subscribes only to cancelled, failed,
  and succeeded payment events; it had no delivery attempts in the prior 24
  hours. Cloudflare exposes secret names only, so the Worker's mode and
  credential alignment remain unverified. No payment was submitted. This is
  status only, not a release prerequisite; details are in `INTEGRATION_NOW.md`.

This snapshot supersedes older dated notes below where they conflict.

Active beta hosting (2026-09-30): Cloudflare Worker `priced` at
`https://priced.pricedapp.workers.dev`. The Vercel project and
`https://internet-price-tag.vercel.app` are rollback/reference only. Older
Vercel references below describe the prior deployment unless superseded by
`INTEGRATION_NOW.md`.

Hostname migration (2026-09-30): the Cloudflare account namespace is
`pricedapp`, and both account Workers moved to that namespace. Dodo Test Mode
webhooks now target the new Priced URL; a signed duplicate event returned HTTP
200, and the 10-check staging smoke passed. The later active-origin Auth
verification below supersedes the pending-auth status in this historical note.

Latest active-origin Auth verification (2026-10-06): the Supabase Site URL is
now `https://priced.pricedapp.workers.dev`, and
`https://priced.pricedapp.workers.dev/auth/callback` is in the redirect
allowlist; the Vercel rollback callback remains. Google OAuth, callback,
sign-out, and re-login passed for the existing `@harshit` account. A fresh
account's welcome/handle-creation path remains unverified on this origin.
External email magic-link UI is disabled until custom SMTP delivery is verified.
PR #83's copy corrections are deployed. Sandbox market rows were reset on
2026-10-08; Dodo-side Test Mode records remain separate. No other hosted
records were deleted.

Latest launch-hardening deploy (2026-10-03): PR #78 merged to `main` as
`b5204ff` and the hardened build was deployed to Worker `priced` as version
`b9377c49-52cd-4057-975e-3beba99c6a1e`, replacing the prior live version
`83d0fcc0` that still ran the `next` `16.3.4` build inside the `next/og`
advisory range. Hosted re-verification: origin `ok`, `smoke:staging` 11/11,
`?check=db` reports `supabase`, the OG routes return PNGs, and the unsigned
webhook probe is rejected HTTP 400. The money-alert backstop is operational
with its existing repository secrets. The daily logical-backup workflow is
merged; it skips without `SUPABASE_DB_URL` and now guards against raw database
artifacts in this public repository.

Earlier sandbox reconciliation (2026-09-18): Dodo Test Mode successfully
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
| OG cards (domain + receipt, Priced branded, prev holder + next price) | CI verified as routes | PNG rendering + headers asserted in `og.spec.ts`; X card validator check is an owner follow-up |

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
| Dodo sandbox matrix (success/fail/cancel/duplicate/stale/simultaneous/refund-failure/missing-metadata/wrong-amount/outage) | Staging verified (partial); clean 25-way same-version timing race Staging verified for tested version | Real Test Mode success, declined payment, signed webhook acceptance, duplicate-event replay/idempotency, provider replay of a successful event with a new HTTP 200 delivery, synthetic provider `payment.failed` and `payment.cancelled` delivery with HTTP 200, a real customer-cancellation state transition with `payment.cancelled` delivered HTTP 200, the fail-closed synthetic missing-metadata/refund-failure path with repeatable HTTP 500 retry behavior, a real missing-metadata payment with successful full refund and no matching sale, cancelled-checkout UI behavior, quote consumption, atomic finalization, Dodo tax-inclusive amount handling, hosted stale/wrong-amount refunds, a hosted terminal-quote payment/refund race, a clean same-version 25-payment race with exactly one sale, 24 stale quotes, zero expiries, and 24 successful full refunds, and the 2026-09-18 stale-signed HMAC/duplicate/forged-signature probe are verified on the stable beta origin. The deployed refund path now fails closed on Dodo `pending`/`review` responses and reconciles signed `refund.succeeded`/`refund.failed` events; the Test Mode endpoint subscribes to all 12 required events. The provider-outage path is also Staging verified: a temporary invalid Dodo base URL returned `502 checkout_failed` before provider payment creation, then the override was removed and normal health/smoke checks passed. On the current age-gated Worker, the UI was verified but no attestation or Dodo checkout was submitted; remaining matrix cases are unverified and are not release prerequisites under the 2026-10-09 policy. Procedure: `DEPLOY.md` §4. |
| Live Dodo configuration | Owner blocked | Dodo Live account and product approved; current Live webhook points to the Vercel rollback URL and lacks refund events; Worker mode/credential alignment unverified. See `INTEGRATION_NOW.md` 2026-10-09 and `DEPLOY.md` §6. Status only, not a release gate. |

## Infrastructure

| Item | Status | Evidence |
|---|---|---|
| Supabase project + migrations + auth + Realtime + backups | Existing-account Google OAuth and isolated logical restore Staging verified; fresh-account auth and scheduled backup Owner blocked | Google OAuth callback, sign-out, and re-login passed on `https://priced.pricedapp.workers.dev` after its Site URL and callback were added on 2026-10-06. The existing account already had a handle; fresh welcome/handle creation was not tested. External email magic-link UI is disabled pending SMTP verification. Database and Realtime remain verified. The daily backup needs both `SUPABASE_DB_URL` and a private or encrypted destination; neither is configured. Supabase Free Plan has no managed backups; PITR remains off. See `INTEGRATION_NOW.md`. |
| Real-Postgres RPC concurrency (10 + 25 racers) | Staging verified | Using an authenticated Supabase CLI database login and bounded PostgreSQL pool, hosted 10-way first-claim concurrency produced exactly 1 `OK`/9 `STALE_QUOTE`, and hosted 25-way held-domain concurrency produced exactly 1 `OK`/24 `STALE_QUOTE`; final states were version 1/price 500/sales 1 and version 2/price 1000/sales 2. The real REST/service-role `tests/integration/postgres.finalize.test.ts` harness also passed all 8 tests with the protected key held transiently in memory. Test rows were removed. |
| Upstash Redis + distributed rate limits | Staging verified | Free-tier database `priced-beta-redis` is created in the new Upstash account (`us-west-1`); REST URL/token are configured only in the active Cloudflare Worker. A clean concurrent hosted run verified handle user/IP `5/15`, profile user `10`, quote user/IP/domain/user+domain `30/60/30/8`, and checkout user/IP `20/30`: the next request in each burst returned `429 rate_limited` with no 5xx. Disposable Auth users, profiles, and quotes were removed; existing `promptpay-staging-redis` was left untouched. |
| Cloudflare Worker beta deployment | Staging verified for health, existing-account Auth, age-dialog UI, and Realtime CSP; additional verification remains unverified (status only; release is owner-controlled) | Worker `priced` serves `https://priced.pricedapp.workers.dev`. Active version `9897cc5d-ebb4-41a2-b888-44d3ca2dee9b` was deployed after PR #87 on 2026-10-08. Read-only post-deploy checks returned liveness `ok`, DB `supabase`, Redis `ok`, origin `ok`; login showed Google and no email magic-link controls. Realtime CSP/WebSocket and the 11-check smoke passed on the preceding version earlier that day. Existing-account Google sign-in/out/re-login and age-dialog UI are verified; fresh-account welcome/handle creation and a real adult age-attested Dodo checkout remain unverified. Dodo dashboard remains in Test Mode and its three account-verification checks are approved. PR #83 copy is deployed; sandbox market rows were reset on 2026-10-08 and the public market is empty. On 2026-09-13 a stale artifact (prerendered pages 500ing with OpenNext's static-to-dynamic error, client bundle missing the inlined public Supabase env) was repaired and redeployed: all public HTML routes return 200, custom 404 renders, health/db/redis/origin are green. On 2026-10-03 the launch-hardening build from `main` (`b5204ff`) was deployed as version `b9377c49-52cd-4057-975e-3beba99c6a1e`, retiring the `next` `16.3.4` build: hosted origin check `ok`, smoke 11/11, DB `supabase`, OG routes PNG, unsigned webhook 400. |
| Vercel project rename `internet-price-tag` → `priced` | Implemented | Existing project renamed through the authenticated Vercel CLI; project id preserved and production alias remains `https://internet-price-tag.vercel.app` |
| Env separation (Local/Preview/Production) | Implemented | Matrix in `.env.example`; active Cloudflare Worker holds beta secrets, while ordinary previews remain secret-free/demo-only. |
| Monitoring/alerts (error-event list, uptime, 5xx rate) | Ledger backstop and uptime workflow Staging verified; real-time alert forwarding Owner blocked until `ALERT_WEBHOOK_URL` is configured | DEPLOY.md §8: exact event queries + uptime endpoints. `src/lib/logger.ts` forwards every error-level event to `ALERT_WEBHOOK_URL` (dependency-free, works on Workers, secret/PII keys stripped). `.github/workflows/money-alerts.yml` scans the hosted ledger every 30 min and opens/updates a `money-alert` issue. `.github/workflows/staging-health.yml` checks liveness, Supabase, Redis, origin, every public HTML route, and webhook reachability every 15 minutes; `.github/workflows/ci.yml` has a separate `Hosted beta smoke` status check. Cloudflare live tail remains available for diagnostics. |
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
| Supabase Realtime CSP/WebSocket | Staging verified | Worker version `d53578bf-3dd8-440d-a189-0bdbaacb729f` serves enforced and report-only CSP headers allowing `wss://*.supabase.co`; hosted headless browser opened one Realtime socket with zero CSP blocks on 2026-10-08. |
| Priced Credits OFF (no read/write path, no UI, no flag) | Verified by absence | `grep credit_ledger src/` → no request path; `grep PRICED_CREDITS src/` → no flag exists (docs/CREDITS.md marks it planned) |
| Analytics privacy (PII strip, no raw webhook bodies, retention ENFORCEMENT) | Staging verified | Route tests plus the merged daily workflow; repository secrets are configured and manual run `34771269757` completed successfully against hosted Supabase (`0` expired rows deleted). DEPLOY.md §9, BACKLOG D5 |

## Trust

| Item | Status |
|---|---|
| 18+ paid-buyer confirmation | CI verified; hosted dialog UI verified, full checkout Owner blocked | Browser coverage checks the unchecked confirmation state and confirmed path to mock checkout. The hosted dialog was opened and cancelled; no attestation or Dodo payment was submitted. This remains self-attestation, not independent age verification; no date of birth or identity document is collected. |
| Terms/Privacy/Refunds copy (plain-language, non-ownership distinction, age requirement, and support email) | Implemented; professional review Owner blocked pending operator identity/address, sufficiency of self-attested age eligibility, grievance contact, legal classification, and tax/privacy review (BACKLOG.md D1). |
| Dodo product-classification confirmation | Implemented (owner-confirmed; see `AGENTS.md` and `INTEGRATION_NOW.md`) |

## Documentation

| Item | Status |
|---|---|
| PROJECT_BLUEPRINT reflects reality (current state, not plan) | Implemented (this pass) |
| DEPLOY runbooks (Cloudflare deploy/build env trap, alerts, retention, operator refunds) | Implemented |
| BACKLOG aligned with this file | Implemented |
| Legal counsel review brief | Implemented as a factual request for advice; not a legal opinion | `LEGAL_REVIEW_BRIEF.md` |
| `.env.example` full audit + environment matrix | Implemented |
| No `[ ]` items describing existing features | Implemented |

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
