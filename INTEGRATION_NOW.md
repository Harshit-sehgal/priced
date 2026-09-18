# Priced Integration Execution State

This file is the current authority for the next execution phase and overrides older wording that treats Dodo product eligibility as unresolved.

## Active beta hosting update (2026-09-12)

The designated free-tier beta origin is now Cloudflare Workers:
`https://priced.harshit10sehgal.workers.dev`. The `priced` Worker is deployed
with the existing Supabase project, Dodo Test Mode, and free Upstash Redis
credentials. Supabase Site URL/redirect configuration and the Dodo Test Mode
webhook endpoint point to this origin. The Vercel project and its
`https://internet-price-tag.vercel.app` alias are retained as rollback/reference
only; older Vercel-specific entries below are historical evidence from the
previous beta deployment.

Cloudflare verification completed: the liveness, Supabase readiness, and Redis
readiness endpoints return healthy; Google-authenticated holder pages render;
a real Dodo Test Mode success payment showed the `$5.00` market amount plus
`$0.90` GST, delivered a signed `payment.succeeded` webhook with HTTP 200,
consumed the quote exactly once, created the immutable sale, updated the
holder/profile/analytics surfaces, and exposed the share card. A declined
Test Mode payment also returned through the failed-payment path without
creating a sale. The Cloudflare staging smoke suite passes all 10 checks,
including the custom 404 route after the static-to-dynamic fix.

## Cloudflare repair + second money-path hardening (2026-09-13)

The active beta was serving a stale artifact whose public HTML pages all
returned 500: `/login`, `/welcome`, `/checkout/mock`, `/about`, `/terms`,
`/privacy`, `/refunds` failed with OpenNext's "Page changed from static to
dynamic at runtime, reason: cookies" — the session-refresh proxy runs on every
matched route, and a statically prerendered page cannot go dynamic at request
time. Every HTML route now renders dynamically (client pages moved behind
server wrappers with `export const dynamic = "force-dynamic"`; the remaining
legal/marketing pages set the same segment config). The Worker was then rebuilt
**with the public `NEXT_PUBLIC_*` values exported at build time** — runtime
Worker secrets never reach the browser bundle — and redeployed. Live
verification after the redeploy: all seven pages 200, custom 404 renders,
health/db/redis/origin green, and the 10-check staging smoke passes.

Money-path hardening (CI verified: typecheck + lint + 210 tests + build +
`cf:build` + real-Postgres suite; needs hosted re-verification):

- A succeeded payment now resolves its provider payment id against the sales
  ledger BEFORE any refund branch, so a duplicate delivery cannot refund a
  funded sale when the quote was flipped terminal by a losing challenger or
  the buyer was suspended/removed since purchase.
- Refund reconciliation cannot downgrade a settled refund
  (`status <> 'succeeded'`), pinned by a forced-interleaving Postgres test with
  a negative control.
- `consumed` quotes are terminal in both adapters.
- A duplicate-key race on `sales.provider_payment_id` maps to
  IDEMPOTENCY_CONFLICT (alert, no refund), never a refundable FINALIZE_ERROR.
- `/api/market/pulse` always returns a real fingerprint (client
  Realtime-vs-polling is a build-time decision; the server's runtime env can
  disagree, which silently froze live refresh).
- Malformed percent-encoding no longer 500s `/domain/[domain]` or
  `/u/[handle]`; reserved-domain OG images render; the profile route has the
  same 4 KiB payload cap as every other mutating route.

Details: `BACKLOG.md` Lane C3.

### Second hardening wave (2026-09-13)

CI verified (typecheck + lint + 218 tests + build + 15-migration real-Postgres
suite + schema equivalence). Hosted migrations applied and verified via the
authenticated Supabase CLI:

- The hosted database was MISSING the operator moderation toolkit
  (`admin_audit` plus `ops_reserve_domain`, `ops_unreserve_domain`,
  `ops_suspend_user`, `ops_unsuspend_user`) even though `db/ops.sql` is the
  documented takedown/suspension procedure. `20260913000001_operator_tooling.sql`
  is now applied to the hosted project; a live privilege query confirms
  `anon`/`authenticated` cannot execute the functions or read the audit table
  while `service_role` can.
- `20260913000002` makes every `finalize_takeover` comparison NULL-proof
  (`x <> NULL` is NULL, which an `if` treats as false, so a NULL argument
  skipped the staleness, price, and idempotency guards). Applied to hosted.
- `20260913000003` adds `domains(holder_handle, price_cents desc)` and
  `sales(created_at desc)` indexes for the holder profile and activity feed.
  Applied to hosted.
- `isIdShaped` now requires a canonical UUID. A 36-character non-UUID (all
  dashes/zeros) passed the old charset check and reached `uuid = '----'`,
  which surfaced as unauthenticated 500s on `/takeover/<id>`, `/success/<id>`,
  `/checkout/return?quote_id=`, and both OG image routes.
- The holder profile no longer scans `listMarket(1000)` — it queries the
  holder's tags directly, which also stops "Currently held" from silently
  truncating beyond the market cap.
- Sitemap reserved filtering is one cached blocklist read instead of up to 500
  per-domain queries.
- Telemetry budget overflow evicts per-client buckets instead of clearing the
  map, which used to reset the instance-wide counter and hand a multi-window
  flood a fresh global allowance.
- `updateProfileExtras` uses `maybeSingle`, so a user with no profile row gets
  `profile_missing` (404) instead of a thrown PGRST116 (500).
- Proxy matcher subtree exclusions are properly anchored, and both the
  scheduled health workflow and the smoke suite now check every public HTML
  route (the outage above was invisible to all previous checks).
- The hosted project's CLI migration history predates the canonical filenames
  (early applies were recorded under other versions), so `supabase db push`
  refuses and must not be history-repaired blindly. New migrations are applied
  one file at a time with `supabase db query --linked --file` and then
  privilege-verified; `DEPLOY.md §1` documents this.

Details: `BACKLOG.md` Lane C4.

### Third wave — display reads + payment config (2026-09-13)

CI verified (typecheck + lint + 221 tests + build + real-Postgres + schema
equivalence + 117 browser tests). Redeployed to the beta (version `1360612b`); live smoke 10/10 and the reserved/malformed OG cards render PNGs.

- Display reads are separated from the money gates: `getDomainForDisplay` and
  `listSalesForDomain` normalize instead of requiring eligibility, so a domain
  added to the operator blocklist AFTER it sold still renders its receipt and
  immutable ledger. The strict `getDomain` throws for reserved tags, which
  would have 500'd `/success/<id>` and its OG card and hidden the ledger.
- `isPaymentConfigConsistent()` makes the provider/datastore guard symmetric:
  the demo provider against the production datastore used to throw from
  `getPaymentProvider()` (500) on checkout and webhooks instead of the
  intended clean 503.
- A suspended holder's outbound CTA is suppressed on tag pages
  (`holderCtaVisible`): suspension already hid the profile page, so a live CTA
  on every tag they still held left the moderation action half-applied.
- Browser coverage for reserved and malformed-percent OG cards; README and
  `.env.example` refreshed off the pre-Cloudflare state.

Details: `BACKLOG.md` Lane C5.

### Fourth wave — full-file re-audit (2026-09-13)

CI verified: typecheck + lint + 238 tests + build + 26 real-Postgres tests +
strengthened schema equivalence + 119 browser tests (120 total, 1 skipped).
Hosted migrations `20260913000004`/`20260913000005` applied and
privilege-verified. Beta redeployed and live smoke 10/10 with all public
routes green.



- **Input validation:** `POST /api/quotes` threw `input.trim is not a function`
  (unauthenticated 500) for a non-string `domain`; now a 400, with route tests.
- **Shared-resource abuse:** `/api/health?check=db|redis` is unauthenticated and
  proxy-exempt; an anonymous loop could burn the shared Upstash quota that the
  fail-closed rate limiter depends on. Deep-check results are now cached for
  30s and `ts` identity is tested.
- **Self-contained privileges:** migration `20260913000004` writes the role
  model down explicitly (schema USAGE, discovery SELECT, money/moderation
  DENY, service_role DML, profiles column-only) instead of assuming the
  Supabase baseline. Applied to hosted and verified there; a new pg test proves
  the model on a database with no baseline, mutation-tested. `finalize_takeover`
  and `holder_analytics` now pin `search_path = public, pg_temp` like the other
  RPCs.
- **Verifier hardening:** `schema-equivalence.mjs` now fingerprints triggers,
  views, sequences and partitioned-table RLS; fingerprints string literals
  separately from whitespace-normalised bodies (a whitespace-obscured literal
  change used to pass); and fails when a `db/*.sql` file is neither applied nor
  declared legacy. Both mutations verified to fail the gate.
- **Money-path tests that were not testing what they named:** the local
  `IDEMPOTENCY_CONFLICT` pg test now actually conflicts (same payment id,
  different args); the forced interleaves assert the loser is still blocked
  before commit; the 25-way held-domain race asserts 24 stale losers; the HTTP
  race harness asserts every loser's refund completed (`refunded === true`)
  instead of printing "no money lost" for a stuck refund; the refund
  idempotency key and event-provider pinning have assertions; buyer-suspended
  after purchase is now a regression case; and the webhook ROUTE has HTTP-level
  tests (success, duplicate, bad signature, oversized, missing metadata,
  failed event).
- **Moderation/display:** suspended profiles are noindexed and excluded from the
  sitemap; a suspended holder's CTA no longer renders on tags they hold;
  receipts and their OG cards honour the DB blocklist like the domain page
  does.
- **Honest UI:** removed the structurally-always-zero "unique sessions" metric
  and per-domain "unique"; labeled truncated holder lists; renamed the
  "Most contested tag" stat to what it actually measures; homepage total is
  labeled as a top-1,000 sample; terminal quotes no longer say "Finalizing…".
- **Failure handling:** login (magic link) and welcome fetch errors can no
  longer leave a permanently disabled button with no message; share-copy
  failures surface; demo checkout guards NaN amounts and network errors;
  quote errors are keyed off the response code, not a status that made two
  messages dead.
- **Promises vs code:** Terms §7 promises a refund when a held tag is reserved;
  the Refund Policy now states the same, and `db/ops.sql` + `DEPLOY.md §7`
  document the operator's manual query → provider refund → audited reservation
  procedure. Analytics retention enforcement is documented honestly
  (`DEPLOY.md §9`) with the owner step tracked as `BACKLOG.md` D5.
- **Docs/tooling:** CI asserts exactly 422 (not just "non-2xx") and bounds the
  job; the smoke suite's unknown-route probe is fatal; `.dev.vars*` and
  `worker-configuration.d.ts` are gitignored; Node `engines` pinned;
  `tests/pg` is now type-checked; BRANCH_PROTECTION, PROJECT_BLUEPRINT and the
  free-tier handoff docs were refreshed off the Vercel-active state.

A second re-audit pass of the changed files found more, and one deployment
incident:

- The domain OG card computed `reserved` from the static list only, so a
  DB-reserved tag still unfurled as claimable ("held by @x · $42 · TAKE IT")
  while `/domain/<tag>` said operator-reserved. It now consults
  `isDomainReserved` and renders "—" / "not a priced tag" for every ineligible
  input instead of advertising a $5 claim.
- The sitemap's new suspended-handle lookup threw on any profiles error,
  turning `/sitemap.xml` into a 500 for every crawler; it is now chunked
  (200 handles/query) and lenient like the reserved display cache, with a
  memory-adapter regression test.
- `client-ip.ts`'s IPv6 check accepted colon-garbage (`1:2:3`, `abc:def`);
  replaced with real IPv6/IPv4-mapped validation and a corpus test.
- Telemetry eviction preserved only the checked dimension's global counter and
  could reset the other dimension's allowance; it now preserves every
  `*:__all__` bucket.
- The `23505` finalize mapping is constrained to the
  `sales.provider_payment_id` constraint (a blanket code arm would misclassify
  a future unique constraint as alert-only and skip a refund);
  `reconcileRefundProviderEvent` now writes `provider_event_id` on the
  existing-row path to match the memory adapter.
- UI/CSS: the bio textarea now shares the input styling (16px — iOS zoom),
  the history ledger's desktop grid has five tracks for five cells, and
  `.btn-block` wraps long share labels instead of hard-clipping them.
- Browser coverage strengthened: CSP probe checks HTTP status (a 500 no longer
  passes vacuously), the analytics privacy test targets a real non-owned
  seeded profile instead of a nonexistent handle, malformed-percent params are
  exercised, and brand/legal/explainer assertions are positive, not
  negative-only.

**Build incident (resolved):** a `cf:build` run that reused a dirty `.next`
from a differently-configured plain `npm run build` produced a Worker that
exceeded Cloudflare's CPU limit (error 1102) on EVERY page render while
`/api/health` and `/api/pulse` stayed green; a rollback to the prior version
restored service immediately. A clean rebuild (`.next` + `.open-next` removed)
deploys and serves normally. `package.json` now has a `precf:build` that wipes
both directories before every Worker build, and `DEPLOY.md §3` documents why
`.next` must never be shared across differently-configured builds.

Details: `BACKLOG.md` Lane C6.

### Fifth wave — payment-outcome exclusion + provider-indeterminacy (2026-09-13)

CI verified: typecheck + lint + 251 tests + 31 real-Postgres tests + schema
equivalence + 119 browser tests. Hosted migration `20260913000005` applied and
verified. Beta redeployed (version `c906abf8`); live smoke 10/10, headers
checked on matched and proxy-excluded routes.

- **CRITICAL: one payment id had two possible outcomes.** `finalize_takeover`
  consulted only `sales` and `claim_refund_attempt` only `refunds`, so a
  payment refunded by a first event could still fund a takeover on a second
  event id (the refund branches do not all make the quote terminal), and a
  takeover could be refunded by a racing claim. Both now serialize on a
  per-payment advisory lock and each refuses when the other's outcome exists:
  finalize raises `PAYMENT_REFUNDING` (webhook acks + alerts, never refunds
  again); claim returns `already_finalized` (no ledger row, no retry).
  `reconcile_refund_event` moved into SQL on the same lock, so a dashboard
  refund event can no longer insert a refund row concurrently with a
  finalization. Proven by forced-interleaving Postgres tests in both orders
  (mutation-verified), plus memory-mirror and route-level tests.
- **Dodo refunds can be indeterminate.** Dodo documents no `Idempotency-Key`
  for `POST /refunds`; a timeout/abort/network failure or an unreadable 200
  body may have executed the refund. Those outcomes are now marked
  `indeterminate` and the ledger parks them in `manual_review` — never an
  automatic retry. HTTP error statuses and pending/review/failed statuses stay
  definitive. Locked with a provider-level test matrix.
- **A crashed webhook delivery no longer strands a payment.**
  `payment_events.processed_at` is exposed to the duplicate handler; a
  `received` row older than 15 minutes (the provider timeout is ~15s) re-enters
  processing with a `webhook_retry_stale_received` alert instead of being
  acknowledged forever.
- The reserved-domain check inside `finalize_takeover` now runs AFTER the
  domain row lock, so a reservation committed before the lock is always seen;
  the memory adapter validates identifiers and enforces the same
  refund/sale exclusion.
- The enforced CSP moved from the session middleware to `next.config.mjs`
  headers, so proxy-excluded routes (`/api/health`, `/api/webhooks`,
  `/api/market/pulse`, sitemap/robots, OG images) now carry it too — verified
  live; `x-powered-by` is disabled.
- Docs: Track A/C statuses and the monitoring checklist no longer name Vercel
  as current; the migrations README warns against `db push` on the existing
  hosted project; `PRICED_CREDITS_ENABLED` is documented as a planned name
  that does not exist in code; DEPLOY's suspension and retention wording was
  corrected; `.env.example` gained the grace-window and base-URL matrix rows;
  the money-path-review skill's triage snippet now uses a real path.

Details: `BACKLOG.md` Lane C7.

### Sixth wave — exclusion refinements (2026-09-13)

CI verified: typecheck + lint + 258 tests + 35 real-Postgres tests + schema
equivalence + 119 browser tests. Hosted migration `20260913000006` applied and
verified. Beta redeployed (version `baae4059`); live smoke 10/10.

An adversarial review of the new exclusion mechanism found two refinements:

- **The refund-after-sale alert was racy.** The webhook route checked for a
  sale BEFORE calling reconcile; a finalization committing in between made
  `reconcile_refund_event` insert the refund row too late for the alert. The
  verdict is now computed by the RPC under the same per-payment advisory lock
  and returned as `(status, sale_exists)`; the route alerts on it. A
  forced-interleaving test holds a finalize open while reconcile waits and
  asserts the verdict sees the committed sale. Provider dashboards can still
  refund after a sale — that cannot be prevented, only recorded and alerted
  (the takeover is never auto-reversed).
- **A definitively failed refund parked the payment forever.** `failed` is
  written only after the provider answered without refunding, so a later
  correct success event may now finalize; live intents
  (`attempting`/`succeeded`/`manual_review`) still block, atomically on the
  advisory lock. A status matrix test pins all four cases.
- The skill's own catalogue gained the two defect classes this work produced:
  "one logical payment, two outcomes" and "provider indeterminacy"
  (`.claude/skills/money-path-review/SKILL.md`), and the C2-1 note no longer
  claims Dodo documents a refund idempotency key.

Details: `BACKLOG.md` Lane C8.

## Locked state

- Product: Priced
- Repository: `Harshit-sehgal/priced`
- Dodo Payments product eligibility: confirmed by owner
- Primary payment provider: Dodo Payments
- Supabase project: already created
- Supabase project ref: `vctlhslzmplawvktnbgb`
- Supabase region: `ap-south-1`
- Supabase plan target: Free
- Supabase migrations: applied through hosted hardening
- Realtime: enabled for required market tables
- Privileged RPCs: service-role only
- Priced Credits: OFF
- Pricing formula: `increment = max($5, 1% of current price)` and `minimum takeover offer = current price + increment`; buyers may choose a higher offer
- Goal: complete a real free-tier sandbox/closed-beta integration before enabling real money

## Recorded execution evidence (2026-09-11)

- The existing Vercel project was reused and renamed from `internet-price-tag` to `priced` without creating a duplicate.
- The stable production alias is `https://internet-price-tag.vercel.app` and is connected to the renamed `priced` Vercel project.
- Vercel Git deployment remains connected to `Harshit-sehgal/priced` with `main` as the production branch.
- The stable Production environment has `NEXT_PUBLIC_APP_URL`, the three Supabase variables, the four Dodo Test Mode variables, and the two Upstash Redis variables configured. Ordinary Preview deployments remain demo-only and do not receive privileged credentials.
- Supabase Site URL is `https://internet-price-tag.vercel.app` and the `/auth/callback` redirect is configured. Google Auth Platform branding and a Web OAuth client are configured for `Priced`; Supabase Google sign-in is enabled, and a real browser login returned through the callback to Priced's welcome/handle setup page.
- Dodo Test Mode contains the approved `Priced Takeover` Pay What You Want product with a $5 minimum and a signed webhook endpoint at `https://internet-price-tag.vercel.app/api/webhooks/payments`. No live mode or real-money configuration has been enabled.
- The Dodo webhook endpoint was initially filtered to the three payment events during the first sandbox pass. Its current configuration includes all 12 events required by the current provider contract: `payment.succeeded`, `payment.failed`, `payment.cancelled`, `refund.succeeded`, `refund.failed`, and the seven dispute lifecycle events. Real Dodo Test Mode success and declined-card payments were exercised after authentication. A real hosted payload exposed that Dodo includes tax in `total_amount`; the integration was corrected to validate the pre-tax market amount, and the regression passed in CI. A post-fix Test Mode success then reached the hosted endpoint, finalized `realtime-success-us-20260911.com`, consumed the quote once, and returned the receipt. Replaying that same signed Dodo message produced a second HTTP 200 delivery and a hosted `webhook_duplicate_event` log without a second takeover. On 2026-09-11, Dodo's endpoint dashboard replayed an existing `payment.succeeded` message and recorded a new HTTP 200 delivery, verifying provider retry/replay handling in Test Mode. Dodo's endpoint Testing control sent synthetic `payment.failed` and `payment.cancelled` samples to the real endpoint, both recorded HTTP 200. A synthetic `payment.succeeded` sample with empty application metadata correctly entered the fail-closed refund path: because Dodo's sample payment is not refundable, the endpoint returned HTTP 500 and a replay returned HTTP 500 again, preserving provider retry semantics without creating a sale. A real Dodo Test Mode checkout created without application metadata then succeeded; its signed webhook returned HTTP 200, Dodo recorded a successful full refund of $5.90 linked to that payment, and a public sales query returned no matching payment ID. This verifies real missing-metadata refund/no-sale handling. A real customer cancellation on a fresh Test Mode checkout returned to `canceltest-mtwstrs0.com?checkout=cancelled`, left the domain unclaimed, and Dodo's endpoint log recorded `payment.cancelled` with HTTP 200. Earlier hosted stale-quote and wrong-amount cases were also refunded successfully. On 2026-09-11, a fresh ten-way hosted Dodo checkout race produced exactly one processed takeover (`@harshit`, version 1) and nine stale quotes. The nine stale webhook paths reached the hosted handler, but the Dodo Test Mode wallet could not close the full refund set: seven were later refunded successfully through the Test API and two refund attempts returned `INSUFFICIENT_WALLET_FUNDS`. The Dodo Test Mode Account Statement showed a $5.90 refund, a +$0.90 tax reversal, and a -$1.00 refund fee per completed refund, so each refund consumes approximately $6.00 of wallet balance; the failure is a provider-wallet funding limit, not a $5-versus-$5.90 application pricing mismatch. A direct full-refund attempt from Dodo's Test Mode dashboard reproduced the same `Insufficient funds in wallet` error; a subsequent dashboard retry still failed, and the Test Mode Account Statement showed only $1.49 total balance. The disposable database fixture was removed; this ten-way race is therefore **External provider blocked** for complete refund closure. The provider-outage path is **Staging verified**; only the 25-way HTTP/payment race remains outstanding.
- Production liveness and Supabase readiness checks pass: `/api/health` returns `ok: true`, and `/api/health?check=db` returns `datastore: supabase` and `db: ok`.
- A new free-tier Upstash account was checked and its designated `priced-beta-redis` database was created in N. California (`us-west-1`). The existing `promptpay-staging-redis` database in the other account was left untouched. Its REST URL and write token are configured only in Vercel Production, and a fresh Production deployment completed successfully.
- The authenticated beta user selected and saved the permanent public handle `@harshit`. The hosted domain, profile, receipt, share URL, and owner-only analytics page render successfully; real hosted analytics now show tag views, profile views, and share visits.
- The hosted staging smoke passes all 9 checks, and `/api/health` plus `/api/health?check=db` are healthy. A clean concurrent run against the deployed Production routes and real Upstash Redis verified every configured limiter without a 5xx: handle user `5/6` then `429`, handle IP `15/16` then `429`, profile user `10/11` then `429`, quote user `30/31` then `429`, quote IP `60/61` then `429`, quote domain `30/31` then `429`, quote user+domain `8/9` then `429`, checkout user `20/21` then `429`, and checkout IP `30/31` then `429`. The quote/domain requests created only disposable quotes, checkout requests used an invalid quote id, and all 20 disposable Auth users, profiles, and quotes were removed afterward. This is **Staging verified** for the complete Upstash quote/checkout/user/IP/domain matrix. A free GitHub Actions workflow now checks both hosted health endpoints every 15 minutes; Vercel Hobby log-drain/alert controls remain unavailable.
- A separate hosted observer session received the live Realtime market update after the post-fix takeover: it changed to `CURRENT HOLDER @harshit`, showed the permanent history entry, and displayed the `$10` next takeover price without a reload. This is **Staging verified** for the live two-session Realtime path.
- The Supabase Database → Backups page confirms that the current Free Plan does not include managed project backups. A real hosted logical schema-and-data dump, followed by restore into an isolated PostgreSQL 17 container, is **Staging verified** using the authenticated Supabase CLI on 2026-09-11. The restored fixture contained 3 domains, 3 sales, 2 profiles, 97 analytics events, and 5 payment events. This verifies the free-tier recovery procedure; managed backups/PITR remain unavailable and PITR is intentionally not enabled for this free beta.
- Hosted database-level concurrency is **Staging verified** using a fresh authenticated Supabase CLI database login and a bounded PostgreSQL client pool on 2026-09-11: 10 simultaneous first claims produced exactly 1 `OK` and 9 `STALE_QUOTE` results; 25 simultaneous takeovers of a held domain produced exactly 1 `OK` and 24 `STALE_QUOTE` results, with final states `version=1/price=500/sales=1` and `version=2/price=1000/sales=2`. Both disposable test domains were removed after verification. The REST/service-role harness is now also **Staging verified**: `RUN_POSTGRES_TESTS=1 npm run test:postgres` ran against the real project with the protected key held transiently in memory and all 8 tests passed; the key was never printed or stored.
- Local typecheck, lint, full tests, production build, and the real-Postgres concurrency harness are green. These results do not count as staging verification.

## Recorded execution evidence (2026-09-12)

- PR #56 (`1d87d45`, “Reconcile asynchronous Dodo refunds”) is merged to `main`; its production deployment `dpl_Go6323vctiHGou5jHxoncRCp14Zj` is Ready and serves the stable alias `https://internet-price-tag.vercel.app`. The post-deploy hosted smoke suite passes all 9 checks. The application now treats Dodo `pending`/`review` refund responses as manual review and reconciles later signed `refund.succeeded`/`refund.failed` events without issuing a duplicate refund.
- The Dodo Test Mode Account Statement was rechecked after deployment: Total Balance remains `$1.49`, so the provider wallet has not replenished. The previously observed two incomplete refunds and the required 25-way hosted HTTP/payment race therefore remain **External provider blocked**; no additional payment race was started against the unchanged wallet.
- PR #53 (`8b86ae3`, “Harden payment and data safety paths”) is merged to `main` with required GitHub CI green. The production deployment `dpl_Eyt2sKn9gd9zsyZQ199C3ptizNs1` is Ready and serves the stable alias `https://internet-price-tag.vercel.app`.
- The four hosted hardening migrations from PR #53 were applied to the existing Priced Supabase project: finalize idempotency recheck, analytics retention, payment disputes, and profiles column privacy. A hosted security query confirmed the dispute table and retention index exist; `service_role` can execute the privileged functions while `anon` cannot; `service_role` can read disputes while `anon` cannot; and `anon` can read public profile fields but not `suspended_at`.
- The stable-origin smoke suite passes all 9 checks after the deployment. Dodo’s signed Test Mode webhook Testing control sent a `payment.failed` example to the live endpoint, and Vercel recorded HTTP 200 on the current production deployment.
- The Dodo Test Mode webhook endpoint now subscribes to all 12 required events: `payment.succeeded`, `payment.failed`, `payment.cancelled`, `refund.succeeded`, `refund.failed`, and `dispute.opened`, `dispute.challenged`, `dispute.accepted`, `dispute.cancelled`, `dispute.expired`, `dispute.won`, and `dispute.lost`.
- Deep-scan money-path hardening (2026-09-12, CI-verified: typecheck + 178 unit tests + build green): deterministic refund idempotency key per payment (`refund:<provider>:<paymentId>` shared by all attempts, per Dodo's "one key per logical intent" contract) replacing the per-attempt claim-token key that could double-refund on timeout-after-success; refund execution pinned to the event's owning provider via `getProviderForEvent` (env switches no longer misdirect refunds); `setQuoteCheckout` fallback resurrection of terminal quotes removed (throws `QUOTE_NOT_CHECKOUTABLE`, route returns 409); `AbortSignal.timeout(15_000)` on Dodo checkout/refund fetches; stale-but-signed webhook deliveries re-verified with the age gate waived (HMAC still enforced) and routed through the money pipeline with a `webhook_stale_but_signed` alert instead of a terminal 400; `x-real-ip` dropped from the trusted client-IP set with literal IPv4/IPv6 validation. The stale-replay and terminal-quote paths are now **Staging verified** on the active Worker; provider-mismatch and timeout-after-success remain CI-verified only because safely forcing them would alter live payment configuration or create an indeterminate external refund. Details in `BACKLOG.md` Lane C2.

## Do not redo

Do not recreate Supabase.
Do not re-investigate Dodo product eligibility unless Dodo asks for another review.
Do not redesign the application.
Do not change the pricing formula.
Do not enable Credits.
Do not weaken RLS, webhook verification, CSRF protections, redirect validation, rate limits, or takeover concurrency controls.
Do not create paid infrastructure without explicit owner approval.

## Parallel integration tracks

### Track A: Cloudflare hosting and auth (Vercel rollback/reference)

1. Gain access to the existing Vercel project currently associated with `internet-price-tag`. **Implemented.**
2. Rename it to `priced` where possible rather than creating a duplicate. **Implemented.**
3. Ensure Git integration uses `Harshit-sehgal/priced` and `main`. **Implemented.**
4. Establish one stable beta/staging origin. **Implemented** — the active origin is the Cloudflare Worker `https://priced.harshit10sehgal.workers.dev`; the Vercel alias is retained for rollback only.
5. Wire the Priced Supabase public URL/key and server-only service-role key into that designated environment (currently the Worker secrets). **Implemented.**
6. Configure Supabase Site URL and redirects using the stable origin. **Implemented.**
7. Configure Google OAuth as the primary beta login. **Implemented.**
8. Verify login, OAuth callback, welcome, handle creation, logout, and repeat login. **Staging verified** with Google OAuth and the saved public handle `@harshit`.
9. Keep ordinary untrusted PR previews in demo mode without service-role or Dodo credentials. **Implemented.**

### Track B: Dodo Payments

1. Work in Test Mode first. **Implemented.**
2. Create or reuse the approved Single Payment Pay What You Want product with minimum $5. **Implemented.**
3. Configure `DODO_PAYMENTS_API_KEY`, `DODO_PAYMENTS_MODE=test`, `DODO_PAYMENTS_PRODUCT_ID`, and `DODO_PAYMENTS_WEBHOOK_KEY` in the designated beta environment only. **Implemented.**
4. Configure the signed webhook endpoint at `https://<stable-beta-origin>/api/webhooks/payments`. **Implemented.**
5. Verify event names and payload fields against current Dodo docs before changing code. **Implemented**: the endpoint is currently subscribed to all 12 required payment, refund, and dispute events; the hosted endpoint configuration was rechecked on 2026-09-12.
6. Run real signed sandbox transactions and the full payment-state matrix. **Staging verified (partial)** for successful and declined payments, signed webhook delivery, duplicate-event replay/idempotency, provider replay of a successful event with a new HTTP 200 delivery, synthetic provider `payment.failed` and `payment.cancelled` delivery with HTTP 200, a real customer-cancellation state transition with `payment.cancelled` delivered HTTP 200, the fail-closed synthetic missing-metadata/refund-failure path with repeatable HTTP 500 retry behavior, a real missing-metadata payment with successful full refund and no matching sale, cancelled-checkout UI behavior, quote consumption, atomic takeover finalization, tax-inclusive provider payload handling, stale/wrong-amount refunds, and the provider-outage path. For the latter, a temporary invalid `DODO_PAYMENTS_BASE_URL` deployment returned hosted `502 checkout_failed` before creating a provider payment; the override was removed and normal health/smoke checks passed. The simultaneous hosted payment race remains outstanding.
7. Validate stale quote refunds, wrong-amount refunds, idempotency, duplicate webhooks, retries, simultaneous challengers, provider failure, and refund failure.
8. Do not enable live mode until the complete integration gate is green.

### Track C: Upstash and operational checks

1. Create one free Upstash Redis database for the designated beta environment. **Implemented** (`priced-beta-redis`, Free Tier, `us-west-1`).
2. Configure the REST URL/token only in that environment. **Implemented** as Cloudflare Worker secrets on the active beta; ordinary previews remain credential-free.
3. Verify quote, checkout, handle, user, IP, and domain rate limits across deployed instances. **Staging verified**: concurrent hosted bursts hit every configured ceiling—handle user/IP `5/15`, profile user `10`, quote user/IP/domain/user+domain `30/60/30/8`, and checkout user/IP `20/30`—with the next request returning `429 rate_limited` and no 5xx. Disposable Auth users, profiles, and quotes were removed after the run.
4. Use free logs and free uptime checks initially. `.github/workflows/staging-health.yml` provides a free scheduled liveness/Supabase/Redis/origin check plus every public HTML route, with GitHub Actions failure notifications. Cloudflare live tail (`npx wrangler tail priced`) is available for diagnostics; Vercel Hobby log drains were unavailable and apply only to the rollback deployment.
5. Check `/api/health` and `/api/health?check=db`.
6. Watch structured critical events during sandbox testing.

### Track D: Integration verification

Start after Tracks A-C have usable hosted resources.

1. Run the hosted REST/service-role Postgres/RPC harness against the real Priced Supabase project. **Staging verified**: the protected key was held transiently in memory and `npm run test:postgres` passed all 8 real-project tests. Direct hosted database-level RPC concurrency is also **Staging verified**: the 10- and 25-request races had exactly one winner each and all other attempts returned `STALE_QUOTE`.
2. Run 10 and 25 simultaneous challenger races through the hosted HTTP/payment path. The ten-way run is **External provider blocked** for complete Dodo Test Mode refund closure: exactly one takeover finalized and nine stale payments were identified, but the sandbox wallet returned `INSUFFICIENT_WALLET_FUNDS` for two refunds after seven were completed. A direct dashboard refund reproduced the same wallet error. The provider-outage path is **Staging verified**: the temporary invalid Dodo base URL returned `502 checkout_failed` before provider payment creation, was removed, and the normal deployment was restored. The 25-way HTTP/payment race remains unrun.
3. Run `npm run smoke:staging` against the stable beta deployment. **Staging verified** (10 checks pass, including every public HTML route).
4. Verify Realtime across two sessions, including a live market update. **Staging verified** on `realtime-success-us-20260911.com`; the observer updated to `@harshit`, history, and the `$10` next price without reload.
5. Complete the real journey: search, login, handle, quote, Dodo sandbox checkout, signed webhook, finalization, history, profile, analytics, CTA, share, and share visit. **Staging verified** for the exercised success path.
6. Verify analytics events and holder aggregation using real sandbox activity. **Staging verified** with hosted tag, profile, and share events and non-empty holder analytics.
7. Verify security headers and direct RPC denial for anon/authenticated roles. **Staging verified**: the Production response includes HSTS, `nosniff`, `DENY`, strict referrer, and permissions headers; direct anonymous Supabase REST calls to `finalize_takeover` and `holder_analytics` both returned HTTP 401.
8. Verify mobile layouts at 375, 430 and 768 px and perform one real-device check where possible.

## Free-tier rule

Sandbox and closed-beta infrastructure should remain free wherever possible.

Do not enable Supabase PITR or buy monitoring solely for staging.
Do not buy a custom domain just to unblock sandbox testing.
Do not upgrade Vercel merely to complete sandbox integration.

Before accepting real customer payments, re-check production hosting plan compliance, disaster recovery, legal documents, support contact, live Dodo credentials, and environment isolation.

## Agent behavior

Make reversible technical decisions without asking the owner each time.
Only interrupt for human authentication, 2FA, KYC, CAPTCHA, acceptance of legal terms, unavailable credentials, or a step that would spend money.
Never invent a completed test or credential.
Use focused PRs and keep required GitHub CI green.

## Completion definition

This phase is complete only when a real hosted beta environment successfully exercises Supabase, Auth, Dodo Test Mode, signed webhooks, Redis rate limits, Realtime, analytics, and concurrency end to end with no unexplained payment state.

## Latest operational verification — 2026-09-13

- The hardening and release-gate changes were merged to `main` in PR #58 (merge commit `902ec064`); required CI passed, including the Cloudflare artifact build, 35 real-Postgres tests, schema equivalence, and the live HTTP race test.
- The active Cloudflare beta was redeployed as Worker version `72efd8da-c2a5-47a8-907b-c670a8976f10`. Liveness, Supabase, Redis, and the 10-check staging smoke all passed after deployment.
- Analytics retention is now **Staging verified**: GitHub repository secrets are configured, the workflow is on `main`, and run `34771269757` completed successfully against the hosted project with zero expired rows to delete.
- Dodo Test Mode remains **External provider blocked** for the outstanding hosted 25-way payment race. The Test Mode Account Statement currently shows `$5.76`; no further refund-heavy race was started against that balance.
- A read-only hosted refund-ledger audit on 2026-09-13 found 10 disposable `unknown_quote` refund rows with no matching sale: seven provider responses were `PAYMENT_ALREADY_REFUNDED`, and three successful Dodo Test Mode payments from the HTTP race fixtures remain in `manual_review` after `INSUFFICIENT_WALLET_FUNDS`. The three payment detail pages confirmed successful `$5.90` charges with the disposable race metadata and an available refund action. No customer-facing sale is associated with these rows; refund completion remains blocked by Dodo's available-wallet balance.
- The owner has already opened a Dodo support conversation requesting Test Mode wallet help (2026-09-11). The latest provider message is an automatic acknowledgment that the team was offline, the request is queued, and it should not be resent; no human provider reply or wallet credit is present yet.

## Latest sandbox reconciliation — 2026-09-17

- Dodo Test Mode remained enabled throughout this work; no live mode and no real-money charge were used. Two additional disposable `$5.00` sandbox checkouts completed through the active Cloudflare beta. The India checkout displayed `$5.00` plus `$0.90` tax (`$5.90` total), while the US-address checkout displayed `$5.00` total. Both hosted return URLs reported `succeeded`, and their quotes were consumed by Priced.
- The three previously wallet-blocked stale-race payments were retried from the Dodo Test Mode dashboard after those sandbox top-ups. Dodo now shows each payment as `Refunded` with a successful full refund; the three provider payment IDs are `pay_0NnNLRt51vzpSKrPYiqGo`, `pay_0NnNLRkBWr3jhkR93LF17`, and `pay_0NnNLRa5GaErAA8VLybb3`. Captured refund records include `ref_0NnoSO00Z5Z5ZaLRw5y3x` and `ref_0NnoT5WJ0vK3BnZQlLFlP`.
- A delayed, read-only Supabase audit after reconciliation found all three corresponding Dodo refund rows in `succeeded` (`unknown_quote`, `unknown_quote`, and `provider_refund_event`). Seven older disposable `unknown_quote` rows remain `manual_review`, and one older row is `failed` with the explicit provider error `PAYMENT_ALREADY_REFUNDED`; these are the known provider-already-refunded cases from the earlier audit and are intentionally not force-mutated without an authoritative signed refund event. No customer-facing sale is associated with these rows.
- `STAGING_URL=https://priced.harshit10sehgal.workers.dev npm run smoke:staging` passes all 10 checks after the sandbox work.
- The 25-way hosted HTTP/payment race remains **External provider blocked** and was not started: it would create 24 stale-payment refunds and, at the observed roughly `$6` wallet debit per refund, needs approximately `$144` of Test Mode wallet capacity plus reserve. The hosted database-level 10/25 concurrency races remain **Staging verified**.
- The confirmed root cause remains Dodo Test Mode wallet capacity and refund fees/tax treatment—not a Priced `$5` versus `$5.90` pricing mismatch. The application validates the pre-tax market amount while the provider checkout may collect tax-inclusive totals.

## Latest sandbox payment race — 2026-09-18

- Dodo Test Mode remained enabled throughout the race; no live mode and no
  real-money charge were used. A fresh disposable tag,
  `dodo-http-race-20260918-c.com`, received 25 real hosted Dodo Test Mode
  payments using the provider's documented success card.
- The hosted return paths and Supabase quote ledger converged to exactly one
  `consumed` quote/sale (`@harshit`, `$5.00`, version 1), eight `stale` quotes,
  and sixteen `expired` quotes. The sixteen expiries are explained by the
  five-minute quote TTL while the deployed user+domain limiter allowed only
  eight new quotes per window; they are not unexplained payment outcomes.
- All 24 non-winning provider payments have `dodo` refund-ledger rows in
  `succeeded`, totaling `$120.00` of market-price refunds, with no matching
  sale. The Dodo Test Mode Account Statement was `$64.13` after the
  25-payment batch and separately reconciled legacy refund, and is now
  `$66.67` after the additional two-quote terminal-race payment/refund check.
- The one legacy payment that had been parked for `INSUFFICIENT_WALLET_FUNDS`
  was refunded from the Dodo dashboard in Test Mode; Dodo confirmed the full
  `$5.90` refund as `ref_0Nnox6QkZBIFncKwfDwK0`, and the matching Supabase
  refund row is now `succeeded`. The remaining seven legacy rows have explicit
  `PAYMENT_ALREADY_REFUNDED` provider responses and no customer-facing sale;
  they remain bookkeeping-only `manual_review` rows until an authoritative
  signed refund event is available.
- A separate disposable two-quote hosted check,
  `dodo-http-terminal-20260918.com`, paid one quote to `consumed`, then paid
  the competing quote through its already-created checkout. The return page
  reported `stale`, and the hosted refund ledger recorded the non-winning
  payment as `succeeded` for `$5.00` with no second sale. This verifies the
  terminal-quote payment/refund race through the real hosted checkout and
  signed webhook path; it did not create a duplicate takeover.
- This is **Staging verified (partial)** for the hosted 25-payment/refund
  path and exactly-once finalization. The clean same-version 25-way race
  timing gate remains **External provider blocked** until it can be run with
  all 25 quotes still within their five-minute TTL (or with separate signed-in
  challenger accounts), without weakening the deployed rate limits.
- `STAGING_URL=https://priced.harshit10sehgal.workers.dev npm run smoke:staging`
  remains green with all 10 checks. Local `npm test` passes 258 tests with 0
  failures and 7 expected real-Postgres skips; `npm run typecheck` passes.

## Latest browser beta pass — 2026-09-18

- The stable Cloudflare beta was exercised in Dodo Test Mode only; no live mode
  and no real-money charge were used. Public pages (`/`, `/about`, `/terms`,
  `/privacy`, `/refunds`, `/login`, `/welcome`), holder profile, analytics,
  claimed receipt/share surface, domain search, quote confirmation, and the
  embedded Dodo checkout all rendered successfully.
- A disposable quote for `beta-browser-20260918-c.com` reached the checkout,
  then was cancelled through Dodo's own confirmation dialog. The tag remained
  unclaimed and no sale or payment was created.
- A separate disposable quote for `beta-browser-20260918-d.com` was submitted
  with Dodo's documented generic-decline card. The return page reached the
  server-authoritative finalization state, Dodo delivered `payment.failed` to
  the signed endpoint with HTTP 200, the tag remained unclaimed, and the Test
  Mode balance remained `$66.67`.
- Hosted health, Supabase readiness, Redis readiness, routing, CSRF, auth
  callback, analytics taxonomy, and unknown-event checks passed again through
  `npm run smoke:staging`. The local Playwright suite passed 119 tests with 1
  intentional skip across desktop and mobile. The hosted browser tab recorded
  zero console errors or warnings.
- This additional pass is **Staging verified** for the exercised public,
  cancellation, declined-payment, signed-failure-webhook, and no-sale safety
  paths. It does not clear the existing **External provider blocked** clean
  same-version 25-way payment race or the owner-gated legal, real-device,
  monitoring, and live-money launch gates.

## Latest hosted money-path hardening probe — 2026-09-18

- The current `main` webhook fix was merged in PR #65 and deployed to the
  active Cloudflare Worker as version `3a457a8f-9d38-454e-ba4a-43e3be2afbc2`.
- A synthetic Dodo Standard-Webhooks `payment.failed` delivery with a valid
  HMAC and a timestamp one hour old was accepted with HTTP 200 and recorded as
  an ignored failed payment. Replaying the same event id returned HTTP 200 with
  `duplicate: true`, proving the hosted stale-delivery and event-idempotency
  path without creating a payment, sale, or refund.
- The same stale timestamp with a forged signature returned HTTP 400 with
  `invalid_signature`, while a fresh forged signature also returned HTTP 400.
  The route now reports the definitive HMAC failure rather than the stale
  timestamp pre-filter reason. This is **Staging verified** for stale-signed
  webhook acceptance and forged-delivery rejection.
- The existing hosted terminal-quote checkout/payment/refund race remains
  **Staging verified**. Provider-mismatch and timeout-after-success behavior
  remain CI-verified only because safely forcing a live provider switch or a
  real network timeout would change payment configuration or create an
  indeterminate external refund.
## Latest signed refund replay reconciliation — 2026-09-18

- Dodo Test Mode's endpoint control was used to replay missing messages from
  the last week to the active signed webhook endpoint. The replay delivered
  the historical `refund.succeeded` events with HTTP 200; no live mode or
  real-money charge was involved.
- The hosted Supabase refund audit now returns **zero** rows with status
  `manual_review` or `failed`. The six legacy `manual_review` rows and one
  `failed` row that had explicit `PAYMENT_ALREADY_REFUNDED` responses all
  converged through authoritative signed provider events. No customer-facing
  sale was associated with any of them, and no database row was manually
  mutated.
- This closes the previously unexplained sandbox refund bookkeeping issue for
  the exercised payments. The remaining payment gate is still the clean
  same-version 25-way timing race, which remains **External provider blocked**
  by the deployed quote limiter and five-minute TTL.
## Latest takeover-funnel verification — 2026-09-18

- The successful-takeover funnel event is now persisted server-side as a
  best-effort analytics write after the atomic quote/sale commit. Analytics
  failure cannot fail or retry the money webhook; duplicate deliveries do not
  emit a second event.
- The merged build was deployed to the active Worker as version
  `a261203e-8184-4e9c-8698-210793a10e93`. A fresh Dodo Test Mode checkout for
  `analytics-beta-20260918-e.com` returned `succeeded`, the hosted return page
  showed `@harshit` holding the tag at `$5.00`, and a hosted Supabase query
  found exactly one `takeover_succeeded` row with `price_cents=500` and no
  previous holder. No live mode or real-money charge was used.
- This is **Staging verified** for the persisted successful-takeover event.
  The repeat-takeover metric still needs explicit share attribution between a
  `share_visit` and a later buyer; the current view sink intentionally stores
  anonymous share visits, so that attribution must not be inferred from a
  mere domain/time match.
## Latest hosted visual/accessibility pass — 2026-09-18

- The active beta origin was reviewed in the hosted desktop browser across the
  homepage/market, About, Terms, Privacy, Refunds, login entry, a held domain,
  holder profile, holder analytics, and the successful-takeover receipt/share
  flow. Each route rendered with its expected headings, links, forms, actions,
  legal disclaimer, and server-authoritative price/holder state; no concrete UI
  defect was found. This is **Staging verified** for the hosted desktop pass.
- CI remains **CI verified** for the 375/430/768 responsive viewports. A
  physical-device/browser-matrix eyeball pass remains **Owner blocked** and is
  not inferred from this hosted desktop review.
## Latest Dodo Test Mode capacity recheck — 2026-09-18

- The authenticated Dodo dashboard still identifies the account as **Test
  Mode**. Its Account Statement now shows a total sandbox balance of
  `$282.32`; the signed webhook endpoint remains enabled and its recent visible
  deliveries are `refund.succeeded` with HTTP 200.
- Eight disposable `$10.00` Test Mode purchases completed through the active
  beta origin on separate `sandbox-topup-20260918-*` tags. Dodo recorded
  `$11.80` per India-address checkout (`$10.00` market amount plus `$1.80`
  GST), with no live-mode or real-money charge involved. A ninth checkout was
  prepared but expired/returned with `requires_payment_method`; it was not
  submitted, and the balance remains `$142.46`. A tenth checkout was prepared
  through the card screen and also returned with `requires_payment_method`
  without a submitted payment or sale; its disposable tag remains unclaimed.
- A clean same-version 25-way timing race would create 24 stale-payment
  refunds. At the observed approximately `$6` wallet debit per completed
  refund, that needs roughly `$144` before reserve. The current balance is
  sufficient for that refund capacity, but the gate remains **External
  provider blocked** until a controlled setup keeps all quotes inside the
  five-minute TTL. The deployed eight-per-window quote limiter and one
  signed-in challenger account still prevent a clean same-version 25-way
  timing run; those controls must not be weakened.
- A subsequent read-only Account Statement refresh showed a `+$177.00`
  aggregate Test Mode payment and the balance increase to `$282.32`. This
  confirms that the wallet-capacity hurdle has changed, but it does not count
  as a 25-way timing result and no new race was started without the required
  distinct signed-in challenger setup.
