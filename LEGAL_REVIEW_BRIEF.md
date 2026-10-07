# Priced — Request for Indian Legal Review

**Prepared:** 2026-10-08

**Purpose:** Obtain written advice before Priced accepts real customer payments.

This brief records the product and current implementation as understood by the
project team. It is not legal advice or a conclusion about the laws that apply.
Please verify the facts, current law, provider terms, and required documents.

## Product facts to review

- Priced sells a paid, temporary symbolic holder position for a familiar
  domain tag inside Priced. It does not sell or transfer the real domain, DNS
  control, website ownership, trademark rights, company ownership, equity,
  affiliation, endorsement, intellectual property, or authority to represent
  the real domain owner.
- A buyer chooses an offer at or above the server-computed minimum. The first
  offer has a `$5.00` minimum. Later minimums add `max($5, 1% of current
  price)`. Prices use integer cents; quotes expire after five minutes. A
  successful offer becomes the displayed price and is recorded in immutable
  takeover history.
- Product value includes a public holder profile and link, takeover history,
  share cards, and holder analytics. There are no user payouts, cash prizes,
  withdrawals, or user-to-user transfers. Priced Credits are disabled.
- Paid buyers must be 18 or older. Checkout uses an affirmative
  self-attestation and a short-lived, quote-bound server token. The service
  does not collect date of birth or identity documents for this gate. This is
  not independent age verification.
- The active beta uses Cloudflare Workers, Supabase, and Dodo Payments Test
  Mode. No live payment processing is enabled. Historical Test Mode tags and
  sales remain visible on public market pages; the sales ledger is immutable.
- The owner has supplied `social.official.me@gmail.com` as a support email.
  Seller/operator legal identity, public address, and grievance-officer
  designation are not yet confirmed. The owner prefers not to publish a
  personal name and needs advice on a compliant structure and disclosure.

## Questions for counsel

1. **Product classification:** Do the paid ranking, takeover, holder profile,
   and outbound-link mechanics fall within any gaming, contest, e-commerce, or
   paid-placement regime? Identify required registrations, restrictions,
   disclosures, or product changes.
2. **Age and capacity:** Is the current 18+ self-attestation suitable for paid
   offers? What controls apply when minors can browse the service? Assess
   applicable child-data, consent, analytics, and advertising rules, including
   future commencement dates.
3. **Seller and grievance disclosures:** What legal person should operate the
   service? Which legal name, address, support details, grievance contact, and
   response process must appear publicly?
4. **Buyer and transaction terms:** Review the Terms, Privacy Policy, and
   Refund Policy for consumer disclosures, cancellation, chargebacks,
   completed-takeover refunds, and the promised refund if an already-held tag
   is later reserved. The current reservation-refund process is manual and
   recorded in an operator runbook.
5. **Tax and invoicing:** Determine applicable GST, invoice, pricing, and
   reporting obligations for Indian and non-Indian buyers.
6. **Privacy and data handling:** Review analytics and retention, user access
   and deletion/export requests, processors/subprocessors, international data
   transfers, and any required notices or consent.
7. **Provider and hosting terms:** Review Dodo Payments terms for the described
   use and assess Cloudflare Workers terms for intended commercial operation.
   Vercel is retained for rollback/reference only.
8. **Launch boundary:** State which activities may proceed in Test Mode or a
   closed beta before live payments, and list every condition that must be met
   before enabling Dodo Live Mode or announcing a public launch.

## Requested written output

Please provide a dated written opinion that identifies the applicable rules,
required product or policy changes, required operator identity and disclosures,
geographic restrictions, tax and privacy steps, and a clear go/no-go decision
for (a) Test Mode beta, (b) closed beta with real payments, and (c) public
launch. Flag assumptions that need confirmation from the owner.

## Project references

- Current integration status: `INTEGRATION_NOW.md`
- Launch gates and evidence: `LAUNCH_CHECKLIST.md`
- Product and payment constraints: `AGENTS.md`
- Operator and deployment procedures: `DEPLOY.md`
- Current user-facing terms: `src/app/terms/page.tsx`,
  `src/app/privacy/page.tsx`, and `src/app/refunds/page.tsx`
