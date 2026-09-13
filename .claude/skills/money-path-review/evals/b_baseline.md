# Review — `webhook.ts` (signed payment webhook)

File under review: `/tmp/mpr-evals/fixture-b/webhook.ts`
Stated contract (lines 1–3): **200 = terminally handled, provider must NOT retry. 500 = transient, provider MUST retry.**

## Root cause that drives most findings

`"received"` is used for two incompatible purposes:

1. an in-flight lock, meaning "another worker is running this right now" (lines 20–24), and
2. the residual state left behind by **every** error path that returns 500 (lines 14, 16, 51) and by every crash between line 12 and lines 35/38/53/57.

Because line 20 answers `"received"` with **200**, the handler asks the provider to retry (500) and then acks away the very retry it asked for. `"received"` is an absorbing state: nothing in this file ever transitions a row out of it except the same request that created it. There is no lease, no TTL, no `received_at` staleness check, and no reclaim path.

---

## C1 — In-flight ack (200) on a stale `received` row silently drops the payment — CRITICAL

**`webhook.ts:20-24`** (with `webhook.ts:12`)

The comment "First delivery still in flight; ack so we cannot run it twice" assumes the first delivery is still alive. Nothing enforces that.

Failure scenario:
1. Delivery #1 arrives. Line 12 inserts the row as `received`, committed.
2. The process dies before reaching line 38 — serverless execution timeout, OOM kill, container rotation during deploy, or a lambda freeze mid-`processPayment`. `processPayment` may or may not have moved money; nothing recorded either way.
3. Provider times out, redelivers. Delivery #2 hits the unique violation at line 13, `existing.status === "received"`, line 23 returns **200**.
4. Provider marks the event terminally handled and stops retrying.

Outcome: the customer was charged and is never credited (or, if `processPayment` had completed, the account is credited but the row says `received` forever). The only artifact is an `info`-level log at line 22 — not an error, so nothing pages.

The fix requires a lease: store `received_at`/`lock_owner` and only return 200 for a `received` row younger than the provider's retry window; a stale row must be reclaimed (CAS `received` → `received` with a new lease) and reprocessed, or return 500 so redelivery continues.

---

## C2 — Dispute path returns 500 for a retry that C1 then swallows; the code's own comment is wrong — CRITICAL

**`webhook.ts:47-52`** (failure absorbed at `webhook.ts:20-24`)

Lines 48–49 claim: "Ask the provider to redeliver; the dispute ledger upserts on event id so it converges." It does not converge. When `recordDispute` fails, the event row is still `received` (written at line 12) and is never marked `error` — unlike the payment path, which marks `error` at line 35 specifically so the replay at line 25 can fire.

Failure scenario:
1. Delivery #1: `dispute.created` arrives. Line 12 inserts `received`. Line 43 `recordDispute` fails (ledger DB down / write timeout). Line 51 returns **500**.
2. Provider redelivers. Line 13 unique violation, `existing.status === "received"`, line 23 returns **200**.
3. Provider stops. `recordDispute` is never retried by anything.

Outcome: exactly the "chargeback with no trace" the comment was written to prevent — after a *single* transient ledger failure, not a rare crash. Funds are pulled by the card network with no dispute row, no deadline tracking, no evidence submission. Severity is raised by the fact that the dispute branch also never records `error`, so there is no recoverable row to sweep.

The same swallow applies to the 500s at **line 14** (`store_failed`, when the insert committed but the client saw a non-unique error such as a post-commit connection reset) and **line 16** (`lookup_failed`, e.g. read-replica lag): both return 500, and the redelivery they request is acked with 200 by line 23.

---

## C3 — `error` replay re-enters processing with no lock and no per-effect idempotency: double-spend — CRITICAL

**`webhook.ts:25-27`** falling into **`webhook.ts:29-39`**

Two independent double-spend mechanisms here.

**(a) Non-atomic `processPayment` replayed wholesale.** A thrown exception does not mean nothing happened. If `processPayment` credits the account / captures the charge and then throws on a later step (ledger append, entitlement write, email, a downstream 502), line 35 marks the row `error` and line 36 returns 500. On redelivery, line 25 deliberately falls through and calls `processPayment` a second time (line 32) on an event that already applied part of its effect. Nothing here passes an idempotency key, checks whether the credit exists, or resets the row to `received` first. Outcome: the customer is credited twice for one payment.

**(b) No mutual exclusion on the replay path.** The only concurrency guard in this file is the `received` check at line 20. An `error` row has no guard at all. Providers commonly fan out redeliveries in parallel after a timeout:
1. Delivery #1 fails, row is marked `error`.
2. Deliveries #2 and #3 arrive concurrently. Both hit the unique violation, both read `existing.status === "error"` at line 15/25, both fall through, both call `processPayment` at line 32.

Outcome: concurrent double credit. The fix is a conditional update — `UPDATE ... SET status='received' WHERE status='error'` and only proceed if one row was affected — so exactly one replay wins.

Note also that line 25's fall-through is not restricted to `error`: any status outside `{processed, ignored, received}` re-enters processing. Any future status value (`pending_review`, `refunded`, a partially-written row) becomes an automatic reprocess.

---

## H1 — `catch {}` at line 35 converts a retryable failure into a permanent drop — HIGH

**`webhook.ts:35`**

`markEvent(..., "error", ...)` is wrapped in a bare `catch {}`. This marking is the *only* thing that makes the payment path recoverable (it is what enables the line 25 replay).

Failure scenario:
1. `processPayment` throws because the database is unavailable.
2. Line 35 tries to write `error` — same database, same outage — and also throws. Swallowed silently; no log, no metric.
3. Line 36 returns 500. Row remains `received`.
4. Redelivery hits line 20–23 and gets **200**.

Outcome: payment permanently dropped. The correlated-failure case (both calls hit the same dependency) is the *common* case, not an edge case, which is what makes this severe.

---

## H2 — Routing on `event.status` alone credits refunds, payouts, and reversals as payments — HIGH

**`webhook.ts:29`** (compare `webhook.ts:53`, `webhook.ts:57`, which record `event.type`)

The handler dispatches purely on `event.status === "succeeded"` and never inspects `event.type`, even though the rest of the file treats `event.type` as the meaningful discriminator worth persisting.

Failure scenario: the provider delivers `refund.succeeded` (or `payout.succeeded`, `transfer.succeeded`, `dispute.won.succeeded`) — a distinct event type whose `status` field is also `"succeeded"` because the *operation* succeeded. Line 29 matches and `processPayment(event)` credits the customer for money that was just returned to them.

Outcome: money paid out and then credited again. The branch must assert on `event.type` (an explicit allowlist of payment-completion types) and treat any unknown type as unhandled rather than falling into the payment path.

---

## H3 — Event-level idempotency is not payment-level idempotency — HIGH

**`webhook.ts:10-12`, `webhook.ts:29-39`**

The uniqueness key is `(provider, event.id)`. Line 45 shows events carry `event.paymentId`, so one payment can produce multiple event ids.

Failure scenario: the provider emits both `payment.succeeded` and `payment.captured` for the same `paymentId`, both with `status: "succeeded"` — or an operator uses the provider dashboard's "resend event", which commonly issues a **new** event id for the same payment. Each has a distinct `event.id`, so line 12 inserts cleanly, the idempotency check never fires, and `processPayment` runs once per event.

Outcome: double credit for a single payment, with both event rows showing a clean `processed`. A uniqueness or check constraint on `paymentId` for payment-applying events is needed in addition to the event-id key.

---

## H4 — Unguarded `markEvent("processed")` after money has moved — HIGH

**`webhook.ts:38`**

`processPayment` has already succeeded and its effects are durable. `markEvent` is awaited with no try/catch, so a transient write failure throws out of `POST`.

Failure scenario:
1. `processPayment` completes; the customer is credited.
2. Line 38 throws (connection reset, pool exhaustion).
3. The exception escapes the handler. The framework's response is whatever its default is — typically 500, but uncontrolled; it is not one of the two documented outcomes, and if the framework maps unhandled rejections to a 502/504 the provider's retry behaviour is undefined.
4. The row is stuck at `received`, so redelivery gets 200 at line 23 and the row stays `received` forever.

Outcome: the ledger permanently disagrees with reality. This is also a live double-spend trap: any reconciliation or sweeper job written against the C1 problem ("replay rows stuck in `received`") will re-run this already-credited payment. Wrap line 38, and on failure either retry the mark or return a 500 the replay path can actually act on.

---

## M1 — Unknown statuses are silently and permanently marked `ignored` with no log — MEDIUM

**`webhook.ts:57-58`**

The terminal fall-through marks **any** unrecognised status `ignored` and returns 200. Unlike the replay path at line 26 and the dispute failure at line 50, it emits no log at any level.

Failure scenario: the provider ships a new money-moving status — `refunded`, `partially_refunded`, `chargeback_reversed`, or a renamed `succeeded` variant such as `succeeded_after_review`. Every such event is swallowed with 200 and recorded as deliberately ignored. Nothing retries, nothing alerts, and the event table actively asserts the events were handled correctly.

Outcome: a whole class of money movement disappears, and the audit trail hides it. Unknown statuses should be recorded as `unhandled` and alerted on, not silently classified as `ignored`.

---

## M2 — `markEvent` at line 53 is unguarded (dispute path) — MEDIUM

**`webhook.ts:53`**

If `recordDispute` succeeds but `markEvent(..., "ignored", ...)` throws, the exception escapes and the row stays `received`. Redelivery is acked by line 23. The dispute row does exist (so this is not data loss), but the event is permanently `received`, and — as in H4 — any stuck-`received` sweeper will re-run the branch. Lower severity than C2 only because the dispute ledger upsert genuinely is idempotent.

---

## L1 — Internal `result` echoed in the webhook response body — LOW

**`webhook.ts:39`**

`return json({ received: true, result })` returns whatever `processPayment` produced to the provider. Webhook responses are logged and displayed in provider dashboards; internal ids, balances, or user data do not belong there. The provider ignores the body. Return `{ received: true }`.

---

## Summary

| # | Location | Issue | Severity |
|---|---|---|---|
| C1 | `webhook.ts:20-24` | Stale `received` row acked 200; no lease/TTL/reclaim — event dropped after any crash | Critical |
| C2 | `webhook.ts:47-52` | Dispute-store 500 leaves row `received`; the requested redelivery is acked away — chargeback lost | Critical |
| C3 | `webhook.ts:25-27, 29-39` | `error` replay has no lock and no per-effect idempotency — double credit, incl. concurrent | Critical |
| H1 | `webhook.ts:35` | `catch {}` on the `error` mark turns a retryable failure into a permanent drop | High |
| H2 | `webhook.ts:29` | Dispatch ignores `event.type`; refunds/payouts with `status: "succeeded"` get credited | High |
| H3 | `webhook.ts:10-12` | Idempotency keyed on event id, not `paymentId` — resent/duplicate events double-credit | High |
| H4 | `webhook.ts:38` | Unguarded `markEvent` after money moved — uncontrolled response, row stuck `received` | High |
| M1 | `webhook.ts:57-58` | Unknown statuses permanently `ignored` + 200 with no log — silent class-wide drop | Medium |
| M2 | `webhook.ts:53` | Unguarded `markEvent` on dispute path leaves row `received` | Medium |
| L1 | `webhook.ts:39` | Internal `result` echoed to the provider | Low |

**Minimum fix set to satisfy the stated retry contract:** give `received` a lease with a staleness check so it can be reclaimed rather than acked (C1); mark the row `error` — not leave it `received` — on every 500 path including disputes (C2, H1); make the replay claim atomic via a conditional status update and pass an idempotency key into `processPayment` (C3); gate the payment branch on `event.type` and key idempotency on `paymentId` (H2, H3).
