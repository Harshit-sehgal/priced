---
name: money-path-review
description: Review AND prove correctness of payment, webhook, checkout, refund, quote and takeover code — the defect classes that silently lose or double-spend money, plus the verification techniques that actually demonstrate a fix rather than assuming it. Use this skill whenever you touch a payment provider (Dodo, Stripe), a webhook handler, an idempotency or retry path, a refund or chargeback flow, a rate limiter guarding checkout, or the finalize_takeover RPC; when adding a migration, CI gate, or test harness for any of those; and above all whenever you are about to write or trust a test for a money bug, reproduce a race condition, or claim a concurrency fix works. Spotting these bugs is the easy half — the bugs that reached production here did so past a green suite, because a regression test nobody watched fail and a parallel-request probe that cannot hit the window both look like proof and are not.
---

# Money-path review

Priced moves real money. A defect here does not throw a stack trace — it
refunds a sale that was valid, keeps money for a sale that never happened, or
lets one person take a tag twice. None of the bugs in this catalogue looked
wrong. All of them passed a green suite.

Use this as a review lens, not a checklist to tick. For each pattern below,
find the concrete line in the code under review that could exhibit it, and say
either "this is safe because X" or "this is the bug". A pattern you cannot map
onto real lines is a pattern you have not actually checked.

**Spend your effort on the proof, not the spotting.** Measured on seeded-bug
fixtures, a careful reviewer finds these defects with or without this
catalogue. What does not happen by default is the verification: mutation-testing
the regression test, and forcing a concurrency interleaving instead of firing
parallel requests. Both bugs that reached production in this repo did so past a
green suite — one test had exactly the right property over a corpus that missed
the case, and one race was declared safe by a parallel probe that could not hit
the window. So treat §9 and `references/verification.md` as the load-bearing
part of this skill; the catalogue below is context for what to look for.

## The one idea behind most of these

**A check taken before the thing that makes it authoritative is not a check.**

Order matters more than presence. A version check before the row lock, an
amount check before the idempotency lookup, a validation on input before
normalisation rewrites it — each looks complete in a diff and is worthless at
runtime. When you see a guard, ask: *what could change between this guard and
the moment its answer is used?*

## 1. Check-before-lock (TOCTOU)

In a concurrent finalizer, anything read before `SELECT … FOR UPDATE` is a
snapshot that a competing transaction can invalidate while you wait on the
lock. Under READ COMMITTED the loser wakes to *new* data but keeps its *old*
conclusions.

Real instance: `finalize_takeover` looked up the `sales` row by
`provider_payment_id` before taking the lock and never re-read it. A duplicate
delivery of an already-finalized payment therefore saw the bumped version and
raised `STALE_QUOTE` — which the caller refunds. The buyer kept the tag *and*
got their money back.

Ask: is every guard that gates a write re-evaluated after the lock is held?

Concurrency alone will not reproduce this. The window is narrow, so parallel
requests usually miss it. Force the interleaving (see §9).

## 2. Check-before-idempotency

Same shape, one layer up. If a validation runs before the idempotency lookup,
a retry that re-derives its inputs slightly differently fails validation and
takes a destructive branch — even though the operation already succeeded.

Real instance: the webhook compared `paidCents` to the quote price *before*
calling `finalizeTakeover`, where idempotency lives. A duplicate delivery whose
amount was re-derived differently (a provider payload variant that omits `tax`)
landed in `amount_mismatch` and refunded a funded sale.

The fix is not to weaken the check. Validation exists to stop a bad payment
*minting* a sale; once a sale exists for that payment id it cannot mint
anything, so the check belongs after — or scoped to the not-yet-committed case.

## 3. A retryable 500 that isn't re-entrant

If your contract is "500 means the provider retries", then returning 500 while
leaving state in a form the *next* delivery treats as terminal silently
discards the retry you just asked for.

Real instance: the dispute-store failure returned 500 but left
`payment_events.status = "received"`. The duplicate handler answers any
`"received"` row with `200 {duplicate, inProgress}` — logged at **info**. One
transient database error meant a chargeback was never recorded and never
alerted.

Ask: after this 500, what will the next delivery of the same event do? Trace it
concretely. Only a status the duplicate handler treats as retryable (`error`
here) actually re-enters processing.

## 4. Fail-closed dependencies shared with the money path

Fail-closed is right for a limiter guarding checkout. It also means anything
that can exhaust that limiter can take checkout down.

Real instance: unauthenticated telemetry (page views, `/api/analytics`) spent
commands on the same free-tier Redis as the quote/checkout/handle limiters.
Because even a *rejected* request costs a command, the Redis limiter could not
bound its own spend — so a flood exhausted the quota and the money path 429'd.

Ask: what else shares this dependency, who can reach it unauthenticated, and
can the guard bound its own cost? A cheap local gate before the network call is
usually the fix.

## 5. Validate the output, not just the input

Normalisation happens *after* your guard and can reintroduce what you rejected.

Real instance: `sanitizeInternalPath` required a leading `/` and checked the
resolved origin. `"/..//evil.com"` passes both — then WHATWG URL normalisation
collapses `/..` leaving pathname `//evil.com`, which is protocol-relative when
the caller resolves it against the real origin. A genuine login became an
attacker-controlled landing page.

Ask: is the value I *return* safe, or only the value I was *given*?

## 6. Dual implementations drift

Two implementations of one rule will diverge, and the divergence surfaces in
production because tests exercise the other one.

Real instances: the in-memory repo adapter keyed profiles by *handle* while SQL
keyed by *id* (so handle hijack was possible in dev and impossible in prod, and
the unique-violation branch was untestable); the pricing formula existed in
four places with nothing asserting they agreed.

Ask: is there a test that runs *both* implementations over the same inputs and
asserts equality? If not, the parity is a hope. See `references/verification.md`.

## 7. Lists rot

Any hardcoded enumeration of files, routes, migrations or events drifts from
reality, and it fails *silently* because the check still passes.

Real instances: the Postgres harness applied a hardcoded migration list that
had drifted, so it certified an outdated `finalize_takeover` — the very
function it existed to prove. CI checked schema sync with `test -f` plus two
`grep`s, which cannot see a changed function body; behind it, `analytics_events`
had never been mirrored into `db/`, so the documented operator bootstrap could
not apply to a fresh database at all.

Prefer globbing, derivation, or a real equivalence check over an enumeration.
When an enumeration is unavoidable, add something that fails when it drifts.

## 8. Platform-trust assumptions

Security properties inherited from the host silently invert when the host
changes.

Real instance: reading `x-forwarded-for[0]` is safe on Vercel, which overwrites
the header. On Cloudflare it is client-forgeable, and the repo was mid-migration
to Cloudflare Workers — which would have made every IP-dimension rate limit
bypassable with a random header per request.

Related: a per-request value cannot exist in prerendered output. A CSP nonce
generated in middleware can never reach a statically built page, so an
enforcing nonce policy blocks every inline script on those routes.

Ask: which guarantees here come from the platform rather than the code, and are
they still true where this will actually run?

## 9. Tests that would pass with the bug present

The most dangerous test is one asserting the right property over a corpus that
misses the case.

Real instance: `navigation.test.ts` asserted exactly the right invariant —
"sanitized output cannot change origin when resolved" — but no input contained
`..`, so the open redirect sailed through a green suite.

**Mutation-test every regression test you write.** Reintroduce the bug, confirm
the new test fails, restore, confirm it passes. A regression test you have not
seen fail is an assumption. This takes two minutes and is the single highest-
value habit in this catalogue.

For forcing concurrency interleavings and other verification mechanics, read
`references/verification.md`.

## Reporting

Lead with what would actually happen to a real user's money, in one sentence,
before any code discussion — "the buyer keeps the tag and gets refunded" lands
where "the idempotency lookup precedes the lock" does not.

For each finding give: `file:line`, the concrete failure scenario (inputs →
wrong outcome), and severity. Say plainly when something suspicious is actually
correct — a verified clean bill of health on the finalizer is worth as much as
a finding, because it tells the reader what has genuinely been checked.

Do not invent findings to seem thorough. An honest "I checked these six
patterns against these lines and found nothing" is a useful result.
