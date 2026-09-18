# Priced

[![CI](https://github.com/Harshit-sehgal/priced/actions/workflows/ci.yml/badge.svg)](https://github.com/Harshit-sehgal/priced/actions/workflows/ci.yml)

**How much is the internet worth?**

Priced is a competitive internet game where people pay to become the current **symbolic holder** of familiar domain names such as `google.com`, `openai.com`, `apple.com`, a friend's site, a competitor, or their own startup.

Nobody receives the real domain, website, company, trademark, IP, equity, DNS control, or legal ownership. A purchase changes only the public price tag and holder shown inside Priced.

> **Agents:** read [AGENTS.md](./AGENTS.md) first, then [INTEGRATION_NOW.md](./INTEGRATION_NOW.md). Those files contain the current infrastructure state, Dodo approval status, Supabase details, free-tier strategy, execution order, security constraints, and hosted verification requirements. They override stale launch wording elsewhere.

## Core loop

1. Search any valid domain.
2. See its current symbolic holder and current price.
3. Enter an offer at or above the required minimum.
4. The successful buyer becomes the new holder.
5. Share the takeover publicly.
6. Someone else can take it later by entering a higher offer.

## Pricing

Unclaimed domains start at **$5**.

```text
increment = max($5, 1% of current price)
minimum takeover offer = current price + increment
```

The buyer may pay more than the minimum; their selected offer becomes the new tag price. Money is stored as integer cents.

## Repository status

**Implemented (Priced core):** market homepage with search, activity, most
contested, fastest rising and newly claimed; domain pages with transparent
price math and permanent provenance ledger (previous holder, price delta,
first claims, totals); holder profiles with optional bio, avatar fields and a
safe external CTA shown on the profile and on held tags; owner-only holder
analytics at `/u/[handle]/analytics` (real counts from `analytics_events`,
honest empty states); server-authoritative quotes (5-minute TTL), versioned
atomic takeovers (Postgres `FOR UPDATE` RPC + in-memory mirror for demo),
Supabase SSR auth + immutable handles, reserved-domain and IDN protections,
Dodo Payments (launch default) + Stripe adapter + demo provider with
idempotent webhooks and stale-quote auto-refund, share attribution + branded
OG cards, realtime display sync, persistent analytics, versioned migrations,
structured payment logging, and CI covering lint, typecheck, unit,
integration, dockerized real-Postgres RPC races, browser (desktop + mobile +
375/430/tablet viewports), production build and a live-HTTP race test.

**Not active:** Priced Credits (spec + ledger exist, flag off, see
[docs/CREDITS.md](./docs/CREDITS.md)).

**Current hosted state:** the Priced Supabase project exists in `ap-south-1`; canonical migrations through the 2026-09-13 hardening wave (finalize NULL guards, read-path indexes, operator moderation toolkit) are applied and privilege-verified; required Realtime tables are enabled; privileged RPCs are service-role only. Dodo Payments product verification/approval is confirmed by the owner. The active free beta runs on Cloudflare Workers at `https://priced.harshit10sehgal.workers.dev`; the renamed Vercel project (`https://internet-price-tag.vercel.app`) is retained as a rollback/reference deployment only.

**Current beta status:** Supabase Auth (Google OAuth), Dodo Test Mode checkout + signed webhooks, free Upstash Redis rate limits, Realtime, holder analytics, share flow, and the hosted success journey are verified on the Cloudflare beta; the 10-check staging smoke, health/db/redis/origin probes, and a scheduled GitHub Actions health workflow are green. Remaining: complete Dodo Test Mode refund closure for the hosted 10/25-way payment race (blocked on the provider sandbox wallet balance), then the real-money launch gates. See [AGENTS.md](./AGENTS.md) and [INTEGRATION_NOW.md](./INTEGRATION_NOW.md).

**Before real-money public launch:** review production hosting plan compliance, disaster recovery/logical backups, legal/support readiness, environment isolation, live Dodo credentials, and the closed-beta results.

The reusable foundation is:

- the product idea and viral loop;
- the market pricing rule;
- domain normalization;
- versioned quotes;
- stale-quote protection;
- atomic takeover semantics;
- immutable sale history;
- payment/webhook safety rules;
- product/legal language.

Read **[PROJECT_BLUEPRINT.md](./PROJECT_BLUEPRINT.md)** before changing the product.

Also see:

- [AGENTS.md](./AGENTS.md) · current source of truth for coding/infrastructure agents
- [INTEGRATION_NOW.md](./INTEGRATION_NOW.md) · immediate integration execution plan
- [MARKET_RULES.md](./MARKET_RULES.md) · exact market mechanics
- [supabase/migrations/](./supabase/migrations/) · versioned migrations (canonical history) + [db/schema.sql](./db/schema.sql) + [db/schema-extended.sql](./db/schema-extended.sql) · portable single-apply equivalents, RLS, atomic takeover RPC
- [db/ops.sql](./db/ops.sql) · operator moderation tooling
- [src/lib/game.ts](./src/lib/game.ts) · deterministic market engine
- [src/lib/game.test.ts](./src/lib/game.test.ts) · market-rule tests
- [tests/integration/concurrency.test.ts](./tests/integration/concurrency.test.ts) · race-condition suite

## Technical direction

- Next.js (App Router) + TypeScript, Server Components by default
- Postgres / Supabase (auth, data, optional realtime)
- server-authoritative quotes and takeovers
- payment-provider abstraction; Dodo Payments behind it (Stripe adapter + demo provider included)
- Cloudflare Workers via OpenNext (active free beta; Vercel retained for rollback/reference)
- realtime market updates
- dynamic Open Graph/share cards

## Foundation checks

```bash
npm install
npm run test
npm run typecheck
npm run lint
npm run build
npx playwright install chromium
npm run test:browser
```

The app runs with no credentials in demo mode using an in-memory market and simulated payments. For the current hosted beta strategy, follow `AGENTS.md` and `.env.example`; do not recreate Supabase or assume a second staging Supabase project is required.

V1 eligibility is explicit: `ALLOWED_SUFFIXES` in `src/lib/domains.ts` is the launch allowlist; IDN/punycode (`xn--`) is rejected to avoid homograph/display risk (DEPLOY.md §10).

The market is a game/status product, **not an investment or domain-ownership product**. Never describe a holder as owning the underlying domain without an immediate explicit disclaimer.
