# Branch Protection & Release Process

> Money-handling repo. Changes to payment, DB and rate-limiting code must not
> bypass CI. This doc is the checklist for whoever has admin on
> `Harshit-sehgal/priced`. It takes ~3 minutes in the GitHub UI.

## Required settings (Settings → Branches → Add rule for `main`)

- Branch name pattern: `main`
- ☑ Require a pull request before merging — 1 approval *(recommended; the live
  rule currently has 0 required approvals — see "Current reality" below)*
- ☑ Require status checks to pass before merging
  - Search for the `verify` job from `.github/workflows/ci.yml` and require it.
  - ☑ Require branches to be up to date before merging
- ☑ Require conversation resolution before merging (optional but recommended)
- ☑ Do not allow bypassing the above settings (applies to admins too, unless you add an explicit bypass list)
- ☑ Restrict who can push to matching branches — no direct pushes by default
- ☐ Allow force pushes — **OFF**
- ☐ Allow deletions — **OFF**

Verify with the CLI (needs `gh` auth):

```bash
gh api repos/Harshit-sehgal/priced/branches/main/protection --jq .
gh api repos/Harshit-sehgal/priced/rulesets --jq '.[].name'
```

### Current reality (2026-09-13)

`enforce_admins`, no force-push, no deletions, and the required `verify`
context are set. `required_approving_review_count` is **0**, so the "1
approval" recommendation above is not yet enforced. Enable it in the UI when a
second maintainer is available; solo development is the reason it is off.

## CI is the gate

`.github/workflows/ci.yml` (`verify` job) must stay required. It runs:

`lint` → `typecheck` → `test:market` → `test:concurrency` → `test` →
`build` → `cf:build` (the artifact that actually ships) → `test:browser` →
`test:pg` (real-Postgres races) → `test:schema` (db/*.sql ≡ migrations) →
analytics/health smoke → live HTTP race.

Never weaken it to unblock a release. If it's red, the release is red.

## Release lanes

- `main` — production lane. CI must be green before merge.
- **Active beta:** Cloudflare Worker `priced` at
  `https://priced.harshit10sehgal.workers.dev`, deployed from this repo with
  OpenNext (`DEPLOY.md §3`). Deploys are manual (`cf:build` then `cf:deploy`)
  and are not triggered by merges; `main` green is the prerequisite.
- **Vercel:** the renamed `priced` project and `https://internet-price-tag.vercel.app`
  remain a rollback/reference deployment only.
- **Preview/PR deployments:** ordinary untrusted previews are **demo-only and
  credential-free** — no Supabase, Dodo, Redis, or service-role secrets. Do not
  follow the old "Preview uses staging Supabase + Dodo test keys" guidance:
  that contradicts the locked isolation rule in `AGENTS.md` and `.env.example`.
- `smoke:staging` (`scripts/staging-smoke.mjs`) is the hosted beta gate:

  ```bash
  STAGING_URL=https://priced.harshit10sehgal.workers.dev npm run smoke:staging
  ```

## Hotfix exception

If production is down and a direct fix is needed, an admin may temporarily
bypass protection, but must immediately open a retro PR and re-enable it.
Document the bypass in the PR description and in `CONTRIBUTING.md` if you add one.
