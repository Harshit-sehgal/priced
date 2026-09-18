# Priced Free Tier Agent Handoff

Read `AGENTS.md` first. This file records the current zero-cost infrastructure strategy for sandbox and closed beta.

If older wording in `DEPLOY.md`, `BACKLOG.md`, or `LAUNCH_CHECKLIST.md` conflicts with this file, `AGENTS.md`, or `INTEGRATION_NOW.md`, use the newer agent files.

Active beta hosting override (2026-09-12): the designated hosted beta runs on
Cloudflare Worker `priced` at
`https://priced.harshit10sehgal.workers.dev`. The Vercel project and
`https://internet-price-tag.vercel.app` are retained for rollback/reference;
older Vercel wording below is historical unless superseded by
`INTEGRATION_NOW.md`.

## Locked objective

Build one real hosted sandbox/closed-beta environment while keeping infrastructure subscription cost at zero wherever possible.

Do not upgrade Supabase, Vercel, Upstash, Sentry, or another provider without explicit owner approval.

Dodo Payments product verification/approval for Priced is already complete. Do not repeat that investigation unless Dodo itself requests another review.

Use Dodo Test Mode until the hosted integration gate is green.

Priced Credits remain OFF.

Pricing minimums remain:

`increment = max($5, 1% of current price)`

`minimum takeover offer = current price + increment`

Buyers may enter a higher integer-cent offer; that selected offer becomes the
new displayed price and is the exact amount expected from the payment provider.

## Supabase

Do not create another Priced Supabase project.

Current project:

- Name: `Priced`
- Ref: `vctlhslzmplawvktnbgb`
- Region: `ap-south-1`
- URL: `https://vctlhslzmplawvktnbgb.supabase.co`
- Plan target: Free

All canonical migrations through hosted hardening have been applied.

Realtime is enabled for the required market tables.

`finalize_takeover` and `holder_analytics` are restricted from `anon` and normal `authenticated` direct execution. The service role retains required access.

Google OAuth callback:

`https://vctlhslzmplawvktnbgb.supabase.co/auth/v1/callback`

Google OAuth is the preferred beta auth path. Magic-link UI exists, but default Supabase SMTP should not be treated as a production-capable external-user mail service.

Never expose `SUPABASE_SERVICE_ROLE_KEY` to the browser.

## Free environment strategy

Use the existing Priced Supabase project as the real sandbox/closed-beta database first.

Do not create a second Priced Supabase project solely for Preview while staying on free infrastructure.

Only one designated hosted beta/staging deployment should receive the real Supabase service-role key, Dodo Test credentials, and Upstash credentials.

Ordinary pull request previews remain in demo mode with no privileged secrets.

Do not enable Supabase PITR during the free sandbox phase.

Before real customer payments, create and test a logical backup procedure using Supabase CLI `db dump` or `pg_dump`, and revisit environment isolation and disaster recovery.

## Vercel (rollback/reference only)

The existing Vercel project has been renamed from `internet-price-tag` to `priced`.

GitHub deployment status confirms the existing Vercel connection still deploys this repository.

The observed workspace slug is:

`harshit10sehgal-2319s-projects`

The current ChatGPT Vercel connector receives `403 Forbidden` when querying this workspace directly. A browser agent in the owner's authenticated Vercel session should handle the project configuration instead of creating a duplicate.

Repository must remain `Harshit-sehgal/priced` with `main` as the production branch.

Its alias `https://internet-price-tag.vercel.app` is rollback/reference only; the active beta origin is the Cloudflare Worker above. A custom domain is not required for the beta.

## Dodo Payments

Dodo is approved as the primary payment provider for Priced.

Use Test Mode first.

Create or reuse the approved Single Payment product with Pay What You Want enabled and minimum price `$5`.

Configure the designated beta environment with:

- `DODO_PAYMENTS_API_KEY`
- `DODO_PAYMENTS_MODE=test`
- `DODO_PAYMENTS_PRODUCT_ID`
- `DODO_PAYMENTS_WEBHOOK_KEY`

Use signed webhook endpoint:

`https://<stable-beta-origin>/api/webhooks/payments`

Run actual Dodo Test Mode transactions and verify successful payment, failure, cancellation, duplicate delivery, stale quote, wrong amount, missing metadata, simultaneous challengers, stale-payment refund, refund failure, provider outage, webhook retry, and idempotency.

Do not enable live Dodo credentials until the full hosted integration gate is green and real-money production requirements have been reviewed.

## Upstash

Create one free Upstash Redis database for the designated beta environment.

Configure:

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

Do not expose these credentials to ordinary PR previews.

Verify distributed quote, checkout, handle, user, IP, and domain rate limits against the deployed environment.

## Monitoring

Do not buy monitoring just to satisfy an old checklist item.

Use the free Cloudflare live tail (`npx wrangler tail priced`) and the GitHub Actions health workflow where possible.

At minimum verify:

- `/api/health`
- `/api/health?check=db`

Watch payment-critical structured events including `refund_failed`, `takeover_finalization_error`, `webhook_store_failed`, `webhook_processing_failed`, `webhook_signature_invalid`, `payment_amount_mismatch`, and `payment_succeeded_takeover_stale`.

## Sequence

Tracks that can start in parallel:

1. Cloudflare Worker beta origin and Supabase Auth (Vercel remains rollback-only).
2. Dodo Test Mode configuration.
3. Upstash Free Redis configuration.

After those resources are available, run hosted integration verification:

1. Auth journey.
2. Hosted Supabase health/RLS checks.
3. Real Postgres/RPC concurrency tests.
4. Real Dodo signed sandbox transaction matrix.
5. Realtime across two browser sessions.
6. Holder analytics using actual sandbox events.
7. Share/CTA flows.
8. Mobile checks at 375, 430, and 768 px.

Only then consider a 10 to 20 person closed beta.

## Agent behavior

Do not recreate completed infrastructure.

Do not mark something `Staging verified` unless it was tested against the real hosted service.

Do not create paid resources.

Do not enable Priced Credits.

Do not redesign the product while integration is the bottleneck.

Do not weaken RLS, RPC restrictions, CSRF checks, rate limits, webhook signature verification, redirect validation, amount validation, or concurrency controls.

Do not commit secrets or database dumps.

Use focused pull requests and wait for required GitHub CI.

Make reasonable reversible decisions without asking the owner for routine approval. Interrupt only for human login, 2FA, KYC, CAPTCHA, acceptance of legal/provider terms, unavailable credentials, or an action that would spend money.
