# Priced Free Tier Auth Gate

This file defines the authentication strategy for the zero-cost sandbox and closed beta phase.

## Primary beta sign-in

Use Google OAuth as the primary sign-in method for external beta users.

The application already implements Google OAuth and email magic-link UI.

Current Supabase project callback:

`https://vctlhslzmplawvktnbgb.supabase.co/auth/v1/callback`

Create a Google OAuth client using that Supabase callback and configure the Google provider in the Priced Supabase project.

With the stable beta origin known (currently the Cloudflare Worker `https://priced.harshit10sehgal.workers.dev`), configure the Supabase Site URL and redirect allowlist to that application origin and verify the full callback flow. Vercel remains rollback-only.

## Magic-link limitation on the free setup

Do not assume Supabase's built-in SMTP is suitable for external closed-beta users.

The default Supabase SMTP service is intended for testing. Without custom SMTP, delivery can be restricted to authorized members of the Supabase organization and has provider-controlled limits.

Therefore:

1. Keep Google OAuth as the reliable external beta path.
2. Magic link may be tested with an authorized project-team email.
3. If external magic-link login is required, configure a free SMTP provider that supports Supabase Auth before advertising that method to beta users.
4. Do not buy an SMTP plan merely to unblock the sandbox.
5. If no free SMTP configuration is available, hide or clearly disable the external magic-link path for beta rather than presenting a flow that cannot deliver mail.

## Secrets

Never commit the Google OAuth client secret, Supabase service-role key, SMTP password, or provider credentials to GitHub.

Do not expose the service-role key through `NEXT_PUBLIC_*` variables.

## Verification

Verify:

1. Google sign-in starts from `/login`.
2. Supabase callback succeeds.
3. The application callback preserves only safe internal redirect paths.
4. New users reach the welcome and handle-creation flow.
5. Existing users return to the intended internal route.
6. Sign-out clears the session.
7. Sign-in again restores a valid session.
8. Magic link is only considered beta-ready if a real email is delivered and the callback is successfully completed.
