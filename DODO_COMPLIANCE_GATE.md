# Dodo Payments Integration Status

Product eligibility is confirmed by the owner. Dodo Payments is the approved primary launch payment provider for Priced.

Do not repeat the product-classification investigation unless Dodo changes its decision or requests additional review.

## Current objective

Integrate Dodo Payments end to end, first in Test Mode, then prepare Live Mode without enabling real charges until the staging gate is green.

Priced sells temporary symbolic holder status for a domain tag inside Priced. It does not transfer the real domain, DNS control, trademark rights, company ownership, equity, affiliation, endorsement, or authority to represent the real domain owner.

There are no user payouts, cash prizes, betting outcomes, chance mechanics, withdrawals, investment returns, resale royalties, or user-to-user fund transfers.

Priced Credits remain disabled.

## Required integration work

1. Use Dodo Test Mode first.
2. Create or reuse the approved Single Payment product with Pay What You Want enabled and a minimum price of $5.
3. Set the Dodo test API key, product id, mode, and webhook signing key in the designated staging environment only.
4. Configure the signed webhook endpoint at the active beta origin: `https://priced.harshit10sehgal.workers.dev/api/webhooks/payments` (Cloudflare Worker `priced`; Vercel is rollback-only). A future custom domain replaces this value in both Dodo and Supabase.
5. Subscribe to `payment.succeeded`, `payment.failed`, `payment.cancelled`, `refund.succeeded`, `refund.failed`, and all supported `dispute.*` lifecycle events used by the implementation; verify the names and payload fields against the current Dodo documentation.
6. Run real signed Test Mode transactions. Do not substitute unsigned mocks for the final webhook verification.
7. Verify successful payment, failed payment, cancellation, duplicate webhook, stale quote, wrong amount, simultaneous challengers, automatic stale-payment refund, refund failure, webhook retry, missing metadata, and provider outage behavior.
8. Confirm exactly one takeover finalizes for a valid paid quote and that losing or stale payments never change ownership.
9. Confirm refund and idempotency behavior against the real Dodo sandbox API.
10. Keep Stripe only as an optional adapter. Do not replace Dodo unless a new provider issue appears.

## Live Mode gate

After the full staging matrix is green, prepare the Production Dodo configuration using separate live credentials and a production webhook secret.

Do not put live Dodo credentials in Preview deployments.

Do not commit any Dodo API key or webhook secret to GitHub.

Do not enable real-money processing until the remaining production hosting, legal-document, disaster-recovery, and end-to-end launch checks are complete.
