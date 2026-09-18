# Priced Agent Context

Read this file before making changes. This repository is the source of truth for all coding and infrastructure sub-agents.

Then read, in order:

1. `INTEGRATION_NOW.md`
2. `AGENT_HANDOFF_FREE_TIER.md`
3. `DODO_COMPLIANCE_GATE.md`
4. `VERCEL_COMMERCIAL_GATE.md`
5. `AUTH_FREE_TIER_GATE.md`
6. `LAUNCH_CHECKLIST.md`
7. `DEPLOY.md`
8. `BACKLOG.md`

If older documents conflict with `INTEGRATION_NOW.md` or this file, use this file and `INTEGRATION_NOW.md`.

## Product

Product name: `Priced`

Repository: `Harshit-sehgal/priced`

Priced is a competitive internet product where a user can choose an offer at or above the displayed minimum takeover price to become the current symbolic holder of a familiar domain tag inside Priced.

The purchase does not transfer the real domain, DNS control, website ownership, trademark rights, company ownership, equity, affiliation, endorsement, intellectual property, or authority to represent the real domain owner.

A holder can receive product value through:

- a public holder profile and CTA/link
- permanent takeover/provenance history
- shareable takeover cards
- holder analytics
- platform credits architecture, but Credits are currently disabled

Follow-up product ideas such as collections, achievements, trending exposure, and verified actual-domain-owner badges are not current integration priorities.

## Locked market mechanics

Unclaimed minimum offer: `$5.00`

Increment:

`max($5, 1% of current price)`

Minimum takeover offer:

`current price + increment`

The buyer may enter any higher amount. The selected offer becomes the new displayed price; no amount below the server-computed minimum is accepted.

Money is stored as integer cents. If the 1 percent increment produces a fractional cent, round the increment up to the next cent.

Quotes are server-authoritative and use a 5 minute TTL.

Takeover finalization is atomic and versioned. Immutable sales/provenance history must remain intact. Stale paid quotes must be refunded and must not change ownership.

Do not change these rules unless the owner explicitly changes product mechanics.

## Current Supabase state

The Priced Supabase project already exists. Do not create another one.

Project name: `Priced`

Project ref: `vctlhslzmplawvktnbgb`

Region: `ap-south-1`

Project URL: `https://vctlhslzmplawvktnbgb.supabase.co`

Plan target: Free

All canonical migrations through hosted Supabase hardening have been applied.

Realtime is enabled for the required market tables, including `public.domains` and `public.sales`.

Hosted security verification established:

- `finalize_takeover` is not executable by `anon` or normal `authenticated` clients
- `holder_analytics` is not executable by `anon` or normal `authenticated` clients
- `service_role` retains the required privileged execution
- quote-owner RLS uses the optimized `(select auth.uid())` form

Do not expose `SUPABASE_SERVICE_ROLE_KEY` in browser code or any `NEXT_PUBLIC_*` variable.

Google OAuth callback for this Supabase project:

`https://vctlhslzmplawvktnbgb.supabase.co/auth/v1/callback`

Google OAuth is the preferred beta sign-in path. Email magic-link support exists in the app, but default Supabase SMTP should not be assumed to work for arbitrary external beta users. A custom SMTP provider can be added later if needed.

## Current Dodo Payments state

The owner has confirmed that Dodo Payments product verification/approval for Priced is complete.

Do not reopen the product eligibility investigation unless Dodo itself requests another review.

Dodo Payments is the primary launch payment provider.

Use Test Mode for integration first.

Create or reuse the approved Single Payment product with Pay What You Want enabled and a minimum price of `$5`.

Expected environment variables:

- `DODO_PAYMENTS_API_KEY`
- `DODO_PAYMENTS_MODE=test`
- `DODO_PAYMENTS_PRODUCT_ID`
- `DODO_PAYMENTS_WEBHOOK_KEY`

Expected webhook route:

`/api/webhooks/payments`

The final hosted endpoint is:

`https://<stable-beta-origin>/api/webhooks/payments`

Run real signed Dodo Test Mode transactions before calling the integration staging-verified.

Required payment scenarios include successful payment, failed payment, cancellation, duplicate webhook, duplicate event, stale quote after payment, wrong amount, missing metadata, simultaneous challengers, stale-payment refund, refund failure, provider outage, and webhook retry.

Exactly one valid takeover may finalize for a given market version.

Keep Stripe as an optional adapter only. Dodo remains the primary provider unless a new provider issue appears.

Do not enable Dodo Live Mode until the hosted sandbox integration is green and the remaining real-money launch gates are reviewed.

## Active hosting state

The active free beta is now hosted on Cloudflare Workers. The existing Vercel
project is retained as a rollback/reference deployment and is not the active
beta origin. The active origin is
`https://priced.harshit10sehgal.workers.dev`.

## Current Cloudflare beta state

- Worker name: `priced`
- Account: the owner's authenticated Cloudflare account
- Stable beta origin: `https://priced.harshit10sehgal.workers.dev`
- Cloudflare Worker deployment is configured with the Supabase public URL/key,
  server-only Supabase service-role key, Dodo Test Mode credentials, Upstash
  REST credentials, and `NEXT_PUBLIC_APP_URL`.
- The Dodo Test Mode webhook endpoint is
  `https://priced.harshit10sehgal.workers.dev/api/webhooks/payments`.
- Supabase Site URL and the `/auth/callback` redirect allowlist include this
  Cloudflare origin.
- `NEXT_PUBLIC_*` values are INLINED at `cf:build` time. Export them in the
  build environment before building; Worker runtime secrets never reach the
  browser. `cf:deploy` uploads the last build output and does not rebuild. See
  `DEPLOY.md §3`.
- Do not expose Worker secrets in browser code or ordinary untrusted previews.
- The free beta must remain in Dodo Test Mode; do not enable Live Mode.

The existing Vercel project has been reused and renamed to `priced` in the owner's workspace. The project id is unchanged. Its historical production alias remains `https://internet-price-tag.vercel.app` and may be used for rollback, but Cloudflare is the designated beta origin above.

The GitHub Vercel deployment target has referenced workspace slug:

`harshit10sehgal-2319s-projects`

The ChatGPT Vercel connector may receive `403 Forbidden` when querying that project/workspace directly. The authenticated Vercel CLI can inspect and manage the project.

Git integration remains connected to `Harshit-sehgal/priced`; the former Vercel production deployment remains available for rollback. The active Cloudflare Worker has the Supabase public URL/key, server-only Supabase service-role key, Dodo Test Mode credentials, Upstash REST credentials, and `NEXT_PUBLIC_APP_URL` configured. Ordinary Preview deployments remain demo-only and do not receive those privileged credentials. The service-role key is never exposed in browser code or `NEXT_PUBLIC_*` variables.

For sandbox and closed beta, use the stable Cloudflare Worker origin above. A purchased custom domain is not required for integration testing.

Ordinary untrusted pull request previews should stay in demo mode and should not receive the Supabase service-role key, Dodo secrets, or other privileged credentials.

Vercel Hobby can be used for non-commercial sandbox/testing, but real paid production hosting must be reviewed for plan compliance before accepting customer payments.

## Current Upstash strategy

Create one Upstash Redis database on the free tier for the designated beta environment.

Expected environment variables:

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

Do not put Redis credentials into ordinary untrusted PR previews.

Verify deployed rate limits for quote, checkout, handle creation, user, IP, and domain dimensions.

Do not buy Redis infrastructure for the initial sandbox or closed beta.

## Environment strategy while staying free

The owner wants the initial environment to remain free wherever possible.

The current Priced Supabase project is the real sandbox/closed-beta database first.

Do not create a second Priced Supabase project solely for Preview while free-tier project slots are constrained.

Use one designated hosted beta/staging deployment with the real Priced Supabase project and Dodo Test Mode credentials.

Keep ordinary PR previews in demo mode with no privileged secrets.

Do not enable Supabase PITR for the free beta phase.

Before real-money production, revisit environment isolation and disaster recovery. A logical backup procedure using Supabase CLI `db dump` or `pg_dump` should be created and tested before relying on this database for customer money.

## Expected environment variables

See `.env.example` for the complete matrix. Important variables are:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `DODO_PAYMENTS_API_KEY`
- `DODO_PAYMENTS_MODE`
- `DODO_PAYMENTS_PRODUCT_ID`
- `DODO_PAYMENTS_WEBHOOK_KEY`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `NEXT_PUBLIC_APP_URL`
- optional `NEXT_PUBLIC_TURNSTILE_SITE_KEY`
- optional `TURNSTILE_SECRET_KEY`
- optional `SENTRY_DSN`

Never commit actual secret values.

## Current execution order

Tracks A, B, and C can proceed in parallel.

### Track A: Cloudflare and Auth

- deploy the existing application to the designated Cloudflare Worker
- establish the stable beta URL
- wire Supabase environment variables
- configure Supabase Site URL and allowed redirects
- configure Google OAuth
- verify sign in, callback, welcome, handle creation, sign out, sign in again

### Track B: Dodo Payments

- configure approved Test Mode product and credentials
- create signed webhook endpoint
- verify current Dodo event names and payload fields
- exercise the real sandbox payment and refund matrix
- fix implementation only when real provider behavior proves it necessary

### Track C: Upstash and Cloudflare operations

- create free Redis
- wire rate-limit credentials to the designated beta deployment
- verify distributed rate limits
- configure free health/uptime/log checks where possible

### Track D: hosted integration verification

Start after A, B, and C provide usable hosted resources.

Verify the full chain:

`search -> login -> handle -> quote -> Dodo checkout -> signed webhook -> atomic takeover -> immutable history -> holder profile -> analytics -> Realtime -> share -> second challenger -> stale/refund race`

Also run 10 and 25 simultaneous challenger races against the real hosted environment. Exactly one takeover may finalize for one market version. The database-level 10/25 concurrency harness is already staging-verified; the remaining end-to-end payment race is blocked by Dodo Test Mode wallet funds for stale-payment refunds.

## Test commands

Useful existing commands include:

- `npm test`
- `npm run test:market`
- `npm run test:concurrency`
- `npm run test:pg`
- `npm run test:browser`
- `npm run test:race`
- `npm run smoke:staging`
- `npm run typecheck`
- `npm run lint`
- `npm run build`

Do not describe a hosted integration as verified because local or CI tests passed. Use the status vocabulary below.

## Status vocabulary

Use these labels precisely:

- `Implemented`
- `CI verified`
- `Staging verified`
- `Production verified`
- `Owner blocked`
- `External provider blocked`

Do not mark a task staging-verified until it ran against the real hosted service.

## Security and scope rules

Do not weaken RLS, privileged RPC permissions, CSRF protections, redirect validation, webhook signature verification, rate limits, amount checks, idempotency, version checks, or concurrency controls to make a test pass.

Do not enable Priced Credits during the initial integration/beta phase.

Do not redesign the UI or add unrelated features while integration is the bottleneck.

Do not introduce paid infrastructure without explicit owner authorization.

Do not commit secrets, database dumps, OAuth secrets, Dodo credentials, Supabase service-role keys, or Redis tokens.

Use focused branches and pull requests. Required GitHub CI must be green before merge.

Agents should make reasonable reversible technical decisions without asking the owner for routine approval. Interrupt only for human authentication, 2FA, KYC, CAPTCHA, acceptance of provider/legal terms, unavailable credentials, or an action that would spend money.

## Known cleanup that is not an integration blocker

`package.json` is already named `priced`; keep the package metadata and lockfile aligned if dependencies are changed. Do not hand-edit a large lockfile just for cosmetic cleanup.

## Completion definition

The current phase is complete only when a real hosted beta environment successfully exercises Supabase, Google Auth, Dodo Test Mode, signed webhooks, Redis rate limits, Realtime, holder analytics, share flow, and takeover concurrency end to end with no unexplained payment state.
