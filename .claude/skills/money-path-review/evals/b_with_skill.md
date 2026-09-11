# Money-path review — `/tmp/mpr-evals/fixture-b/webhook.ts`

Reviewed under `.claude/skills/money-path-review` (SKILL.md + references/verification.md),
using the "trace every non-2xx return to the next delivery" method from
references/verification.md §"Tracing a webhook retry to its conclusion".

## What would actually happen to real money

**A customer files a chargeback, the dispute ledger has one transient hiccup, and
the chargeback is never recorded, never retried and never alerted — the first
anyone learns of it is the bank debiting the account.** The handler returns 500 to
ask for a redelivery, but it leaves the event row in a state its own duplicate
handler answers with `200 {duplicate, inProgress}` at log level `info`. The retry
it asked for is thrown away, and the comment on line 48-49 asserts the opposite of
what the code does.

The same trap swallows successful payments (Finding 2) and any crash mid-handler
(Finding 4).

---

## Retry-state table (every exit traced)

| line | status returned | `payment_events.status` left behind | what the next delivery of this same event does |
|---|---|---|---|
| 7  | 400 invalid_signature | no row | provider does not retry — correct, an unverifiable body must not loop |
| 14 | 500 store_failed | no row | insert succeeds, full processing — **re-entrant, safe** |
| 16 | 500 lookup_failed | unknown (row exists) | unique violation → re-reads → branches on real status — **safe** |
| 18 | 200 duplicate | processed/ignored | nothing — **correct** |
| 23 | 200 duplicate,inProgress | `received` | **nothing, forever** — see F1/F2/F4 |
| 36 | 500 processing_failed | `error` *(if the mark succeeded)* | falls through at L25 and reprocesses — **correct by design** |
| 39 | 200 result | `processed` | nothing — correct |
| 51 | 500 dispute_store_failed | **`received`** | **line 23: 200, silently dropped** — F1 |
| 54 | 200 | `ignored` | nothing — correct |
| 58 | 200 ignored | `ignored` | nothing — but see F6 |

---

## F1 — Dispute 500 is not re-entrant: a chargeback is lost and never alerted

**`webhook.ts:47-52`** (trap at `webhook.ts:20-24`) — **Severity: Critical**

`recordDispute` failing returns 500 without ever moving the event row off
`"received"` (set at line 12). The only status the duplicate handler treats as
retryable is `"error"` (line 25).

Failure sequence:
1. Delivery #1 of `evt_disp_1` (`status: "disputed"`). Line 12 inserts the row as
   `received`.
2. `recordDispute` at line 43 returns `{ok:false}` — one connection blip, one
   ledger timeout, one transient constraint error.
3. Line 51 returns **500**. Row is still `received`.
4. Provider redelivers `evt_disp_1`. Line 12 raises a unique violation → line 20
   matches `"received"` → **line 23 returns 200 `{duplicate, inProgress}`**, logged
   at **`info`**.
5. Every subsequent redelivery does the same. The provider stops after its first
   2xx.

**Outcome:** no dispute row exists, no `error`-level log exists, no alert fires, and
the event is permanently marked as handled-in-flight. The chargeback proceeds
with no trace on our side — money leaves the account against a sale nobody ever
flagged.

The inline comment is actively misleading: *"Ask the provider to redeliver; the
dispute ledger upserts on event id so it converges."* The upsert never runs again,
because the redelivery never reaches line 43.

**Fix shape:** `await markEvent(provider.name, event.id, "error", "dispute_store_failed")`
before returning 500 — the same shape line 35 already uses for the payment path —
and log the drop at `error`, not `info`.

---

## F2 — The `catch {}` on the error-marking makes a funded payment vanish

**`webhook.ts:35`** — **Severity: Critical**

```ts
try { await markEvent(provider.name, event.id, "error", "processing_exception"); } catch {}
```

The empty catch is the whole bug. The 500 on the next line is only honoured if
that mark landed; the `catch {}` is precisely the case where it did not.

Failure sequence:
1. Buyer pays. `payment.succeeded` arrives for `evt_pay_1`; row inserted as
   `received`.
2. `processPayment` throws — which in practice means the database is unhappy,
   which is exactly when `markEvent` on line 35 also fails.
3. The failure is swallowed. Line 36 returns 500, row still `received`.
4. Redelivery → line 23 → **200**. Provider considers the event delivered.

**Outcome:** the buyer's card is charged, the sale/takeover is never finalized, and
the event is filed as "in progress" forever at `info`. Money kept for a sale that
never happened. The two failures are correlated, so this is not a rare tail —
it's the common case whenever the database is the thing that broke.

**Fix shape:** if the mark fails, the row cannot be trusted; log at `error` and
still 500, but the duplicate handler must not treat `received` as terminal (see
F4) or nothing rescues this.

---

## F3 — Reprocessing an `error` row has no single-flight guard: concurrent double-processing

**`webhook.ts:25-26` → `webhook.ts:32`** — **Severity: High**

The handler's only mutual exclusion is the unique-violation on the *insert* at
line 12. On the retry path the row already exists, the fall-through at line 25
does **not** re-claim it (no `markEvent(..., "received")`, no conditional
compare-and-set from `error` → `received`, no row lock), and the status stays
`error` for the entire duration of `processPayment`.

This is SKILL.md §1 one layer up: the guard that makes single-flight authoritative
is taken once, at insert time, and never re-taken.

Failure sequence:
1. `evt_pay_2` fails processing; row marked `error`.
2. The provider's retry schedule fires a redelivery; a slow response causes the
   provider to send a second redelivery (or an operator replays the event) while
   the first is still running.
3. Both hit the unique violation, both read `status === "error"`, both fall through
   line 26, **both call `processPayment(event)` concurrently**.

**Outcome:** `processPayment` runs twice in parallel for one payment. Whether that
double-spends depends entirely on `processPayment`/`finalizeTakeover` being
concurrency-safe *by payment id* — this file provides none of that protection,
while its own comment on line 21 claims it does ("ack so we cannot run it twice").
If the downstream finalizer is the `finalize_takeover` shape from SKILL.md §1,
the loser also risks waking to a bumped version and taking a refund branch.

Not reproducible by firing N parallel requests — force the interleaving with two
connections per references/verification.md §"Forcing a concurrency interleaving":
hold the winner's transaction open after it reads `error`, start the loser, then
commit.

**Fix shape:** claim the row with a conditional update
(`update … set status='received' where event_id=$1 and status='error'`) and only
proceed if it affected a row.

---

## F4 — `received` is terminal with no lease, so any crash drops the event permanently

**`webhook.ts:20-24`** — **Severity: High**

`received` is written at line 12 and cleared only by reaching line 35, 38, 53 or 57
*in the same process*. Nothing bounds how long a row may sit in `received`, and the
duplicate handler answers it with 200 unconditionally.

Failure sequence:
1. `payment.succeeded` for `evt_pay_3`; row inserted as `received`.
2. The process dies between line 12 and line 38 — serverless timeout, OOM kill,
   instance recycle, deploy mid-request. No catch block runs.
3. Provider redelivers (it got no response at all). → line 23 → **200
   `{duplicate, inProgress}`** at `info`.

**Outcome:** a paid-for sale is never finalized and the only evidence is an
`info` log saying everything is fine. This is the generalisation of F1 and F2: the
duplicate handler cannot distinguish "another worker is mid-flight right now" from
"a worker died three days ago", and it resolves the ambiguity in the direction
that discards money.

**Fix shape:** store a claim timestamp with `received` and treat a row older than
the provider's own retry window as retryable (fall through like `error`), or
return 500 rather than 200 for a stale `received` so the provider keeps trying.
Log stale-`received` at `error`.

---

## F5 — Unguarded `markEvent` after successful processing

**`webhook.ts:38`** (same shape at `43`, `53`, `57`) — **Severity: Medium**

Line 38 is outside the try/catch. If it throws, the exception escapes `POST`, the
framework returns a generic 500 for a payment that was *fully and successfully
processed*, and the row is left at `received`.

Failure sequence: `processPayment` succeeds → line 38 throws → framework 500 →
provider redelivers → line 23 returns 200, `processPayment` never re-runs.

**Outcome:** money is correct (the work was done), but the event is stuck at
`received` forever, a successful payment is reported to the provider as a failure,
and the row is indistinguishable from the F2/F4 cases — so reconciliation over
`received` rows cannot tell a harmless stuck row from a genuinely dropped payment.
That is what makes the Critical findings above hard to detect after the fact.

---

## F6 — The catch-all ignore terminally discards every unenumerated event status

**`webhook.ts:57-58`** — **Severity: Medium**

Only `"succeeded"` and `"disputed"` are handled; every other `event.status` is
marked `ignored` (terminal) and 200'd, with no log above the default. SKILL.md §7:
this is a hardcoded enumeration that fails *silently* when reality drifts.

Failure sequence: the provider starts emitting `refunded` / `partially_refunded` /
`dispute_won` / `payment.reversed`. Each is filed as `ignored` + 200. Because
`ignored` is terminal (line 17), the events cannot be replayed later even after the
gap is discovered — recovery requires DB surgery to rewrite statuses.

**Fix shape:** log unrecognised statuses at `warn`/`error` with the raw type, and
mark them `unhandled` rather than `ignored` so they remain replayable. Reserve
`ignored` for an explicit allow-list of statuses you have decided to drop.

---

## F7 — Idempotency is keyed on `event.id` only

**`webhook.ts:12`** — **Severity: Low (informational)**

De-duplication is per provider event id. Two distinct event ids describing the same
payment (a provider replay under a new id, or the same payment surfacing in two
event types) both reach `processPayment`. That is the correct layering *provided*
`processPayment`/the finalizer is idempotent on `provider_payment_id`; this file
gives no protection of its own. Worth an explicit assertion in the finalizer's
tests, since nothing here enforces it.

---

## Verified clean — checked and not a bug

- **`webhook.ts:5-7` — signature verification precedes every state write.** `raw`
  is the unparsed body, verification runs before `recordEvent`, and an invalid
  signature returns 400 with no row created. A 400 (not 500) is right: an
  unverifiable payload must not be retried in a loop. **Safe.**
- **`webhook.ts:14` — non-unique store failure returns 500 with no row written.**
  The next delivery inserts cleanly and processes in full. Genuinely re-entrant.
- **`webhook.ts:16` — `lookup_failed` 500.** Row exists but is unreadable; the next
  delivery re-reads and branches on the real status. No state is stranded. **Safe.**
- **`webhook.ts:35-36` — the payment error path is the *correct* shape** (mark
  `error`, then 500, and `error` re-enters processing at line 25). It is the model
  the dispute path at line 51 fails to follow. Its only defect is the `catch {}`
  (F2), not the ordering.
- **SKILL.md §2 (check-before-idempotency) does not apply here.** This handler
  performs no amount/quote comparison before `processPayment`, so there is no
  pre-idempotency validation able to push a duplicate delivery onto a refund
  branch. If such a check is ever added, it must go *after* the event-id insert and
  inside `processPayment`'s idempotency scope.
- **SKILL.md §4, §5, §8** have no mapping in this file: no rate limiter or shared
  fail-closed dependency, no sanitiser/normalisation, and no platform-derived
  trust beyond the signature check, which is verified in-code rather than inherited
  from the host.

---

## Regression tests to write (mutation-test each one)

Per SKILL.md §9 and references/verification.md, none of these counts until you have
watched it fail with the bug reintroduced:

1. `recordDispute` returns `{ok:false}` → assert the row status is **`error`**, then
   redeliver and assert `recordDispute` is called a **second** time. (Fails today.)
2. `processPayment` throws **and** `markEvent` throws → assert redelivery re-enters
   `processPayment`. (Fails today.)
3. Kill the handler after line 12 (simulate by inserting `received` directly), then
   deliver → assert the response is not a terminal 200. (Fails today.)
4. Two concurrent deliveries against an `error` row → assert `processPayment` is
   invoked exactly once. Force the interleaving with two connections and a held
   transaction; a plain parallel fire proves nothing.
5. An unknown `event.status` → assert it is logged above `info` and left replayable.

Cross-check the first three with the §"Tracing a webhook retry" audit: every
`status: 500` in this file must have a `markEvent(..., "error", ...)` that is
*guaranteed* to have run before it. Today, two of the three do not.
