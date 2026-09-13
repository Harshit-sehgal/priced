# Vercel Commercial Use Gate

The active free beta now runs on Cloudflare Workers at
`https://priced.harshit10sehgal.workers.dev`; the Vercel project is retained
for rollback/reference. This gate remains relevant only if Vercel is selected
again for real-money production. Cloudflare's applicable commercial terms and
limits must still be reviewed before enabling live payments there.

This is a launch policy gate, not a sandbox blocker.

The current objective is a zero-cost sandbox and closed beta environment. Vercel Hobby may be used for non-commercial testing and development, subject to Vercel's current terms and limits.

Do not accept real customer payments on a Vercel Hobby deployment if doing so would violate Vercel's current non-commercial Hobby restriction.

Before enabling real money, choose one compliant hosting path:

1. Upgrade the existing Vercel project to a plan that permits commercial use.
2. Move the production deployment to another hosting platform whose current terms permit the intended commercial use.

Do not start a paid Vercel plan merely to complete sandbox verification.

Do not block Google OAuth, Supabase, Dodo Test Mode, Upstash, browser testing, or the closed no-real-money sandbox on this decision.

When agents report production readiness, they must distinguish technical readiness from hosting-plan compliance.
