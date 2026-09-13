# Go-Live Runbook

Everything code-side is implemented and tested. This is the short, ordered
path from this repository to accepting real money. Steps are owner-gated
because they need accounts, credentials and a legal review.

## 0. Prerequisites

- This repo with `main` green on CI.
- A domain for the app itself (e.g. `priced.game`).

## 1. Supabase (data + auth + realtime)

1. Use the existing Supabase project `Priced` (`vctlhslzmplawvktnbgb`, `ap-south-1`). Do not create another project for this phase.
2. Apply migrations deterministically — choose one path:
   - **Fresh database, Supabase CLI (recommended):** `npx supabase db push` (applies `supabase/migrations/*` in order).
   - **Plain SQL Editor / psql:** in **SQL Editor**, run `db/schema.sql`, then `db/schema-extended.sql`, then `db/ops.sql` (the operator moderation toolkit) in order, or `for f in supabase/migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done`. The portable files assume the Supabase role baseline; they now grant the privileges they need explicitly (migration `20260913000004`).
   - Either path creates the same tables, `finalize_takeover` RPC (service-role only), `analytics_events` sink, RLS, and `supabase_realtime` publication.
   - `supabase/migrations/` is the versioned history; `db/*.sql` is the portable single-apply equivalent — keep them in sync (see `supabase/migrations/README.md`).
   - **Existing hosted project (`vctlhslzmplawvktnbgb`) — do NOT run `db push`.**
     Its migration history was recorded by early applies under non-canonical
     versions, so `db push` refuses with "Remote migration versions not found"
     and a blind history repair would make it replay every canonical migration.
     Apply NEW migrations to the hosted project one file at a time and verify:
     ```bash
     npx supabase db query --linked --file supabase/migrations/<new>.sql
     # then confirm the object/grant exists, e.g.:
     npx supabase db query --linked "select has_function_privilege('anon','public.<fn>(...)','execute');"
     ```
     Every migration is written to be re-runnable (idempotent DDL), so this is
     safe; it simply bypasses the history table, which is already non-canonical.
3. **Authentication → Providers**: enable **Google** (needs an OAuth client from Google Cloud Console with redirect `https://<project-ref>.supabase.co/auth/v1/callback`) and **Email magic link** (disable confirm-signup captchas if you don't need them).
4. **Authentication → URL Configuration**: set Site URL to your app origin and add `<origin>/auth/callback` to redirect URLs.
5. Copy from **Project Settings → API**:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY` (server secret — never expose to the browser)

## 2. Dodo Payments (launch provider)

1. Dodo product verification/approval for Priced is already confirmed by the
   owner. Do not repeat the eligibility investigation unless Dodo requests it.
2. Create or reuse a **one-time product with Pay-What-You-Want enabled** (min $5.00,
   no low max — each quote passes its exact next price as the cart `amount`).
   Copy its product id → `DODO_PAYMENTS_PRODUCT_ID`.
3. Copy from the Dodo dashboard:
   - `DODO_PAYMENTS_API_KEY` (test key first, live key later — never mix)
   - `DODO_PAYMENTS_MODE=test` (preview) / `live` (production)
   - Webhook secret: add an endpoint `https://<your-domain>/api/webhooks/payments`
     subscribed to `payment.succeeded`, `payment.failed`, `payment.cancelled`,
     `refund.succeeded`, `refund.failed`, and the Dodo `dispute.*` lifecycle events (`opened`, `challenged`,
     `accepted`, `cancelled`, `expired`, `won`, `lost`), then copy
     `DODO_PAYMENTS_WEBHOOK_KEY`.
4. Use test credentials first; run the §76 sandbox gate (below) before switching live.
5. Stripe remains only as an optional adapter (`STRIPE_*` keys) for experiments —
   when both are set, Dodo wins.

## 3. Cloudflare Workers (active free beta hosting)

The active beta origin is:

`https://priced.harshit10sehgal.workers.dev`

The Worker is named `priced` and is deployed from this repository with
OpenNext. It has the existing Supabase project, Dodo Test Mode, and the free
Upstash Redis credentials configured as Worker secrets. Deploy with:

```bash
# 1. NEXT_PUBLIC_* are INLINED INTO THE CLIENT BUNDLE at build time. Worker
#    runtime secrets do NOT reach the browser, so they MUST be exported here.
#    A build without them ships a client that cannot create the Supabase
#    browser client (login fails with AUTH_NOT_CONFIGURED) or subscribe to
#    Realtime — and nothing detects it until a user clicks.
export NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
export NEXT_PUBLIC_SUPABASE_ANON_KEY=<public anon key>
export NEXT_PUBLIC_APP_URL=https://priced.harshit10sehgal.workers.dev
npm run cf:build   # precf:build wipes .next/.open-next first — see below

# 2. `cf:deploy` uploads the LAST BUILD OUTPUT — it does not rebuild. Always
#    run cf:build first, or you deploy a stale artifact.
npm run cf:deploy
```

**Always build the Worker from a clean tree.** `precf:build` deletes `.next`
and `.open-next` before every `cf:build`. A dirty `.next` shared with a plain
`npm run build` (which inlines a DIFFERENT NEXT_PUBLIC_* environment) once
produced a Worker that exceeded Cloudflare's CPU limit (error 1102) on every
page render while `/api/health` stayed green — the artifact was wrong, not the
code. `.next` is environment-specific; never reuse it across differently
configured builds.

The CI job also runs `cf:build`, but deliberately without public env: it is a
compile gate for the Worker adaptation, not a deployable artifact. Production
deploys must use the exported-variable sequence above.

After a deploy, verify the public dependencies and route contract:

```bash
curl https://priced.harshit10sehgal.workers.dev/api/health
curl https://priced.harshit10sehgal.workers.dev/api/health?check=db
curl https://priced.harshit10sehgal.workers.dev/api/health?check=redis
curl https://priced.harshit10sehgal.workers.dev/api/health?check=origin
# Public pages must render (OpenNext 500s a prerendered page the proxy makes
# dynamic at request time; every HTML route is force-dynamic for this reason):
for p in /login /welcome /checkout/mock /about /terms /privacy /refunds; do
  curl -fsS -o /dev/null "https://priced.harshit10sehgal.workers.dev$p" || echo "FAILED $p"
done
STAGING_URL=https://priced.harshit10sehgal.workers.dev npm run smoke:staging
```

Keep ordinary untrusted previews secret-free/demo-only. Keep Dodo in Test Mode
until the legal, backup, monitoring, closed-beta, and provider-wallet gates
are explicitly cleared.

## 3a. Vercel (rollback/reference hosting)

> **Project rename:** the existing project id
> `prj_uOsxAmofMbpp5spVp32YRINEKYys` has been renamed to `priced`.
> Its historical production alias is `https://internet-price-tag.vercel.app`.
> The Git integration continues to deploy `Harshit-sehgal/priced` from `main`.

1. Reuse the linked project; framework is already configured as Next.js.
2. Keep the Vercel deployment available for rollback only. The beta origin and
   Supabase redirect URLs use Cloudflare as described in §3. A custom domain is
   not required for sandbox.
3. Set environment variables for **Production** and separately for
   **Preview** (§58 — never share production DB/webhooks with previews):
   ```
   NEXT_PUBLIC_APP_URL=https://internet-price-tag.vercel.app # rollback/reference origin only
   NEXT_PUBLIC_SUPABASE_URL=...
   NEXT_PUBLIC_SUPABASE_ANON_KEY=...
   SUPABASE_SERVICE_ROLE_KEY=...        # Server secret — separate values for Production/Preview
   DODO_PAYMENTS_API_KEY=...            # Test key on Preview, live key on Production
   DODO_PAYMENTS_MODE=test|live
   DODO_PAYMENTS_PRODUCT_ID=...         # One-time PWYW product id
   DODO_PAYMENTS_WEBHOOK_KEY=...        # Matching webhook secret per env
   UPSTASH_REDIS_REST_URL=...           # One free DB for the designated beta environment
   UPSTASH_REDIS_REST_TOKEN=...
   NEXT_PUBLIC_TURNSTILE_SITE_KEY=...   # Optional, production bot protection
   TURNSTILE_SECRET_KEY=...
   DEMO_WEBHOOK_SECRET=...              # Demo only — unset/ignored when any provider or service-role key is set
   ```
   Keep ordinary untrusted PR previews free of Supabase service-role, Dodo,
   and Redis credentials. A separate Redis database can be introduced later
   when environment isolation is revisited for real-money production.
4. Deploy `main`. The preview environment runs in demo mode by default.

## 4. Sandbox payment gate (§76)

On a preview deployment with Dodo **test** credentials, run and record results for:
successful payment, failed payment, cancelled checkout, duplicate webhook
delivery (replay the same event), stale quote (take the domain from another
session before paying), simultaneous checkout from two sessions, refund of a
stale payment. **No unexplained payment states are permitted.**

Money-path hardening notes (deep-scan pass, 2026-09-12 — CI-verified, needs
hosted verification before counting as staging-verified):
- Refund idempotency keys are deterministic per payment
  (`refund:<provider>:<paymentId>`, shared by all attempts for that payment),
  per Dodo's "one key per logical intent, reused across retries" contract —
  a timeout-after-success followed by a retry converges instead of
  double-refunding. Do NOT rotate these keys per attempt.
- Refund execution is pinned to the event's owning provider
  (`getProviderForEvent`): a Dodo↔Stripe switch or key rotation between
  payment and refund must not misdirect the refund to the wrong provider.
- Dodo checkout/refund calls carry `AbortSignal.timeout(15_000)`. An abort is
  indeterminate (the provider may have executed) — it stays on the
  lease/manual-review path, never a clean failure.
- Stale-but-signed webhook deliveries (valid HMAC, age past the 10-minute
  window) flow through the money pipeline with a `webhook_stale_but_signed`
  alert instead of a terminal 400. Verify with a dashboard replay of an old
  `payment.succeeded` event: expect HTTP 200 and either a sale or a
  ledger-tracked refund, never a silent drop.
- `setQuoteCheckout` refuses terminal quotes (`QUOTE_NOT_CHECKOUTABLE` →
  HTTP 409 `quote_<status>`). Verify by expiring a quote, then attempting
  checkout: expect 409, and the quote row must stay `expired`.

The repository command `npm run test:postgres` targets the real-project
integration harness at `tests/integration/postgres.finalize.test.ts`; it is
gated by `RUN_POSTGRES_TESTS=1` and the server-only Supabase service-role key.
On 2026-09-11, the harness ran against the real Priced project with the
protected key held only in process memory and all 8 tests passed. The key was
not printed or written to the repository.
As an additional hosted database check, on 2026-09-11 an authenticated
Supabase CLI login and bounded PostgreSQL pool ran 10 first-claim requests and
25 held-domain takeover requests concurrently. Each race produced exactly one
`OK` and the remaining `STALE_QUOTE` results, with the expected final version,
price, and one sale per version. The disposable test rows were removed. This
proves database-level hosted locking; the REST/service-role harness is also
verified, while the end-to-end HTTP/payment race remains outstanding.

## 5. Content + safety pass

- Read `terms`, `privacy`, `refunds` pages and have them reviewed by a
  professional (plan §49). Edit freely — they are plain text pages.
- Add any sensitive domains you want blocked to the `reserved_domains` table
  (see `db/ops.sql` for operator queries).

## 6. Flip to live

- Switch Dodo to live mode keys, update the webhook endpoint secret.
- Watch the Cloudflare live tail (`npx wrangler tail priced`) for the structured events from §56
  (`takeover_succeeded`, `payment_succeeded_takeover_stale`, `refund_failed`,
  `takeover_finalization_error`) and wire alerts to the error-level ones.
- Start with the closed beta (§77) before announcing publicly.

## 7. Backups & recovery (production Supabase / Postgres)

- **At real-money promotion only** (not during the free beta, and not before the owner approves paid infrastructure): enable daily backups and Point-In-Time Recovery (PITR) in Supabase **Dashboard → Database → Backups**.
- Keep at least 7 days of PITR window in production (verify via the dashboard after the first production sale).
- **What is authoritative:** `sales` rows are the immutable ledger. `domains` can be rebuilt from sales; never rewrite sales to fix a bad state — append or operator-correct via `db/ops.sql` audit + reserved-domain/suspension actions. Reserving a tag that is currently held carries a refund obligation (Terms §7): refund the last funded payment in the provider dashboard first, then record the reservation with the refund reference in the audit detail — `db/ops.sql` has the query and the procedure.
- **Restore procedure:** use Supabase's PITR restore to the last known-good timestamp, then verify `domains` vs `sales` consistency and that `finalize_takeover` still satisfies the in-memory race tests (`npm run test:concurrency`). Re-verify the webhook signing secret and `SUPABASE_SERVICE_ROLE_KEY` are unchanged after restore.
- **Free-beta logical backup verification:** on 2026-09-11, the hosted public schema and data were dumped with the authenticated Supabase CLI and restored into an isolated PostgreSQL 17 container. The restore completed with 3 domains, 3 sales, 2 profiles, 97 analytics events, and 5 payment events. This is **Staging verified** evidence for the logical recovery procedure; it is not managed backup/PITR coverage. The Free Plan does not provide managed project backups, so keep PITR disabled during the free beta.

## 8. Monitoring (item 9)

All server logs are single-line JSON; optionally mirrored to Sentry when
`SENTRY_DSN` is set (server-side, sampling 0.1; no client SDK yet).
Add `SENTRY_DSN` to the active deployment env (Cloudflare Worker secret) when
you wire the alert destination. Until then, the Cloudflare live tail
(`npx wrangler tail priced`), the `.github/workflows/staging-health.yml`
15-minute probe, and `https://<your-domain>/api/health` (and `?check=db` for
readiness) are the monitoring path. Vercel Hobby log-drain controls were
unavailable and apply only to the rollback deployment.

Alert on any of these at level `error`:

- `refund_failed` — an automatic refund attempt failed; retry is bounded by the refund ledger.
- `refund_manual_review` / `refund_completion_unknown` — money needs manual reconciliation; the payment was NOT applied.
- `takeover_finalization_error` — includes `IDEMPOTENCY_CONFLICT` (payment-id
  reuse, never auto-refunded) and other finalizer failures.
- `webhook_store_failed` / `webhook_processing_failed` — webhook returned 500
  and the provider will retry; investigate if repeated.
- `webhook_signature_invalid` spikes — possible misconfigured secret or abuse.
- `payment_amount_mismatch` — paid amount differs from the quoted price;
  the payment is auto-refunded, but a spike means tampering or a pricing bug.
- `payment_succeeded_takeover_stale` — a paid challenger lost the race; a
  spike means quotes are expiring before payment completes (raise urgency
  if checkout conversion drops alongside).
- `payment_already_holder` / `payment_wrong_price` — correct rejections, but
  repeated occurrences from one account suggest scripted abuse.
- `webhook_payment_unknown_quote` — payments arriving for quotes that do not
  exist; can indicate stale test events pointed at the wrong environment.

Uptime checks (owner, any provider):

- `GET /api/health` every 60s → expect `200 {"ok":true}`.
- `GET /api/health?check=db` every 300s → expect `200`; alerts on `503`
  mean the service role cannot reach Postgres.
- `.github/workflows/staging-health.yml` runs liveness, Supabase readiness, and
  Redis readiness checks every 15 minutes
  from GitHub Actions and can also be started with `workflow_dispatch`.
  GitHub Actions failure notifications provide a free baseline alert path;
  this does not replace structured-event alerting.

5xx rate alerting (Cloudflare analytics or Sentry): alert when 5xx responses
per minute exceed 5 for 5 consecutive minutes. The webhook route uses 500
intentionally for retryable failures, so separate webhook-path 500s from
page-route 5xx in the query when possible.

Structured-event query patterns (the JSON log line's fields; filter the
Cloudflare live tail or your Sentry event stream):

- refund failures:        `level="error" AND event="refund_failed"`
- finalizer failures:     `level="error" AND event="takeover_finalization_error"`
- signature failures:     `level="warn"  AND event="webhook_signature_invalid"` (rate > N/hour)
- amount mismatches:      `level="error" AND event="payment_amount_mismatch"`
- stale takeover losses:  `level="warn"  AND event="payment_succeeded_takeover_stale"` (rate > N/hour)
- store failures:         `level="error" AND event IN ("webhook_store_failed","webhook_processing_failed")`

Triage queries: filter by `payment_id`, `quote_id`, `event_id` — every event
carries them. `payment_events.payload_hash` correlates retried deliveries.
Never log raw webhook bodies or secrets; only hashes and ids. Sentry (when
`SENTRY_DSN` is set) receives the same `event` name and sanitized tags —
no payload bodies, no secrets.

## 9. Analytics retention and privacy

`analytics_events` rows contain: event name, optional handle, optional
domain, optional per-tab session id, sanitized props (primitives only, no
secret/token/password/email keys), timestamp. No IPs, no emails, no user
agents, no payment payloads (webhook bodies are reduced to a SHA-256 hash
in `payment_events`).

Retention: `public.prune_analytics_events()` (migration `20260912000002`)
deletes rows older than 180 days in bounded batches. The daily scheduler is
`.github/workflows/analytics-retention.yml` (free GitHub Actions); it only
runs once the workflow is on the default branch AND the two repo secrets below
exist.

**Enforcement status:** scheduled workflows only run from the repository's
default branch, and the job skips cleanly when repo secrets
`SUPABASE_PROJECT_URL` + `SUPABASE_SERVICE_ROLE_KEY` are absent. Until both are
true, the privacy page's "deleted after about 180 days" claim is NOT enforced.
Owner step: add the two repository secrets and merge the workflow to `main`.
Manual fallback (any time):

```sql
select public.prune_analytics_events();  -- repeat until it returns 0
```

Holder-facing metrics (tag views, sessions, share visits, CTA clicks) use a
30-day window in queries, so pruning old rows beyond 180 days loses nothing
the product displays. Sales/ledger rows are NEVER pruned (immutable history).

The per-tab session id is `sessionStorage`-backed: it dies with the tab,
persists nowhere else, and cannot track a person across sessions or devices.

## 10. IDN / eligibility limits (V1)

- V1 intentionally limits eligible suffixes to the `ALLOWED_SUFFIXES` allowlist in `src/lib/domains.ts` and **rejects IDN/punycode** (`xn--`) to avoid homograph/display ambiguity. Document this limit before launch; a future migration can add IDNA2008 + confusable analysis when ready.

## Operational notes

- Suspended users are blocked at quote creation (the API answers
  `ACCOUNT_SUSPENDED`) and on the payment path (a succeeded payment for a
  suspended buyer is refunded with reason `buyer_suspended`). Suspend via the
  SQL in `db/ops.sql`.
- Refunds of stale payments are automatic. Refunds of completed takeovers are
  not granted (see the refunds policy page) except as required by law.
- The old placeholder UI is fully replaced; do not resurrect it.
