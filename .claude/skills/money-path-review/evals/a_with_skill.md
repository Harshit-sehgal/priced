# Money-path review — fixture-a (`finalize.sql`, `handler.ts`)

## What happens to real money

Three ways a real buyer's money goes wrong here, in plain terms:

1. **A buyer who legitimately bought the seat gets their money back and keeps the seat.** Two deliveries of the *same* webhook that overlap in time make the second one conclude "someone else won" and issue a refund — for a payment that already bought a seat. (F1, and again by a different route in F3.)
2. **A buyer pays and gets nothing, permanently, with no refund and no retry.** Any failure the handler doesn't have a named branch for — a dropped database connection, a deadlock, a lock timeout — is answered with `200`, which tells the payment provider "done, stop retrying." The charge stands, no seat exists, no refund is issued. (F2.)
3. **The first buyer of a brand-new event can take a seat at a price nobody validated.** Under a first-purchase race the price and version guards both evaluate to NULL, which `IF` treats as false, so they pass without checking anything. (F4.)

---

## F1 — Idempotency is read before the lock and never re-read after it

**`finalize.sql:14` (lookup) vs `finalize.sql:23` (lock); refund fires at `handler.ts:18`** — **Severity: Critical**

`select * into s from seat_sales where payment_id = p_payment_id` at line 14 runs *before* `select … for update` at line 23. Under READ COMMITTED, everything read before the lock is a snapshot that a competing transaction can invalidate while you wait on that lock — and this function never re-reads the sale after acquiring it. This is SKILL.md §1, the same shape as the real `finalize_takeover` defect.

**Concrete scenario.** Event `evt_42`, `version = 7`, `price_cents = 5000`. The provider delivers `payment_id = pay_abc` twice (at-least-once delivery, or a retry after a timeout on a slow first call). The two deliveries overlap:

| | T1 (first delivery) | T2 (duplicate delivery) |
|---|---|---|
| t0 | line 14: no sale for `pay_abc` → proceeds | |
| t1 | line 23: takes lock on `evt_42` | line 14: no sale for `pay_abc` (T1 uncommitted) → proceeds |
| t2 | line 25: `7 = 7` OK; line 32: bumps version to 8; line 34: inserts sale | line 23: **blocks** on T1's row lock |
| t3 | COMMIT | wakes, re-reads `d` → `version = 8` |
| t4 | | line 25: `8 <> 7` → `raise STALE_QUOTE` |

`handler.ts:16` catches `STALE_QUOTE` and `handler.ts:18` calls `refund(ev.paymentId, "stale_quote")`. **The buyer holds the seat from T1's committed sale and has been refunded the full 5000 cents.** The seller is out a seat and out the money.

The loser woke to new data (`version = 8`) but kept an old conclusion (the idempotency lookup from t1). The guard that *would* have caught it — "is there already a sale for this payment id?" — is the one that was never re-evaluated after the lock.

**Fix direction:** move the `seat_sales` lookup (or repeat it) *after* line 23, inside the locked region, and return `s` if found. The pre-lock lookup can stay as a fast path but must not be the only one.

**Verification:** this will not reproduce under parallel load — the window is microseconds. Force it with the two-connection recipe in `references/verification.md` §"Forcing a concurrency interleaving": open T1, call the function, hold the transaction open, start T2 so it parks on the row lock, sleep 400ms, commit T1, then read what T2 concluded. The bug shows as T2 raising `STALE_QUOTE` where it should have returned T1's sale row.

---

## F2 — Every unclassified failure returns a terminal 200, discarding the retry

**`handler.ts:23`** — **Severity: Critical**

```ts
return { ok: true, alert: outcome.code };
```

The contract on `handler.ts:1` is explicit: *"200 = terminal, 500 = provider retries."* This line returns `ok: true` for **every** outcome code that isn't `STALE_QUOTE` or `WRONG_PRICE`. There is no `500` anywhere in this handler. This is SKILL.md §3 with the polarity flipped: rather than a 500 that isn't re-entrant, it's a 200 for cases that were never terminal.

**Concrete scenario A (transient infrastructure).** Buyer pays 5000 cents. `finalizeSeat` fails with a connection reset, a `deadlock detected`, or a `lock_timeout` while waiting at line 23 — all ordinary Postgres/pooler conditions under load, none of which are `STALE_QUOTE` or `WRONG_PRICE`. Line 23 returns `200`. The provider marks the event delivered and **never retries**. The charge is captured; no row exists in `seat_sales`; no refund was issued. The buyer has paid 5000 cents for nothing, and the only trace is an `alert` field in a response body nobody reads. There is no path by which this self-heals.

**Concrete scenario B (`IDEMPOTENCY_CONFLICT`).** `finalize.sql:16` raises `IDEMPOTENCY_CONFLICT` when a sale exists for the payment id but the event, buyer, or amount doesn't match. That also lands on line 23 → `200`, no refund, money captured. If the mismatch is spurious (see F5) the buyer is charged for a seat they aren't recorded as owning.

**Concrete scenario C (`INVALID_PAYMENT_ID`).** `finalize.sql:10` raises on a blank payment id. Same terminal 200, same captured-and-orphaned money.

**Fix direction:** partition the codes explicitly. `STALE_QUOTE`/`WRONG_PRICE` are terminal-with-refund; `IDEMPOTENCY_CONFLICT`/`INVALID_PAYMENT_ID` are terminal-with-alert-and-refund (money must not just sit); *everything else*, including anything unrecognised, must be `500` so the provider retries — and the retry must be re-entrant, which F1 currently prevents it from being.

---

## F3 — The quote existence check runs before idempotency and refunds on a duplicate

**`handler.ts:3–4`** — **Severity: High**

```ts
const quote = await getQuote(ev.quoteId);
if (!quote) return { ok: true, refunded: await refund(ev.paymentId, "unknown_quote") };
```

This is a validation that gates a *destructive* action (a refund), placed *before* the layer where idempotency lives (`finalizeSeat`). SKILL.md §2 exactly: a retry that re-derives its inputs slightly differently takes a destructive branch even though the operation already succeeded.

**Concrete scenario.** First delivery of `pay_abc` succeeds: sale committed, then `handler.ts:13` runs `markQuote(quote.id, "consumed")`. The provider re-delivers `pay_abc` (at-least-once delivery does not stop at a 200 — duplicates happen after network-level response loss, and many providers re-send on manual replay). Second delivery calls `getQuote(ev.quoteId)`. If `getQuote` filters by status — `where status = 'pending'`, the overwhelmingly common shape once a `consumed` status exists at all — it returns null. Line 4 refunds 5000 cents for a payment that bought a seat that is still owned. **Buyer keeps the seat and gets the money back.**

The same branch fires if quotes are TTL-expired or purged by a cleanup job between the sale and a late re-delivery.

**This finding is conditional on `getQuote`'s filter,** which isn't in the fixture. If `getQuote` returns consumed and expired quotes verbatim and only returns null for a genuinely unknown id, the branch is safe — but that is a load-bearing property of a function defined elsewhere with nothing here asserting it. Either way the ordering is wrong.

**Fix direction:** before refunding for `unknown_quote`, look up `seat_sales` by `ev.paymentId`. If a sale exists for this payment, return it as a duplicate — never refund. Validation exists to stop a bad payment *minting* a sale; once a sale exists for that payment id it can't mint anything, so the check belongs after.

---

## F4 — NULL guards and an unchecked `found` let a first-purchase race mint an unpriced sale

**`finalize.sql:22–30`** — **Severity: High**

```sql
insert into public.events(event) values (p_event) on conflict (event) do nothing;
select * into d from public.events where event = p_event for update;

if d.version <> p_expected_version then raise exception 'STALE_QUOTE'; end if;
if p_paid_cents <> d.price_cents then raise exception 'WRONG_PRICE'; end if;
```

Two compounding problems: `INSERT … ON CONFLICT DO NOTHING` **does not block** on a concurrent *uncommitted* conflicting insert — it speculatively inserts, detects the conflict, and skips without waiting. And `select … into d … for update` only locks rows *visible to the snapshot*; an uncommitted row from another transaction isn't visible, so there is nothing to lock and nothing to wait on. The function then never checks `found`.

When `d` is all-NULL, `d.version <> p_expected_version` is NULL, not true — and plpgsql `IF` treats NULL as false. Same for `p_paid_cents <> d.price_cents`. **Both money guards silently pass.** A check that cannot fail is not a check.

**Concrete scenario.** Event `evt_new` has no row in `events` yet (first ever purchase). Two buyers pay simultaneously, B1 for 5000 cents and B2 for 1 cent, both quoting `expectedVersion = 0`:

- T1 (B1): line 22 inserts the `evt_new` row, line 23 locks it, guards pass against real values, line 32 bumps to version 1, line 34 inserts B1's sale. Still uncommitted.
- T2 (B2): line 22 `on conflict do nothing` — conflicts with T1's uncommitted row, **skips without waiting**. Line 23 — T1's row is invisible, returns **zero rows**, `d` is all-NULL, `found` is false and never checked.
- T2 line 25: `NULL <> 0` → NULL → no raise. T2 line 28: `1 <> NULL` → NULL → **no raise**.
- T2 line 32: `update events … where event = p_event` matches zero visible rows — the version is never bumped.
- T2 line 34: inserts a `seat_sales` row for B2 at **1 cent**, for a 5000-cent seat, with no version bump.

Result: two sales rows exist for one seat, one of them at an arbitrary attacker-chosen price, and the version counter — the entire mechanism enforcing "exactly one buyer per seat version" — was bypassed rather than contested. The invariant on `finalize.sql:1` is violated without any exception being raised.

The same NULL-collapse fires non-concurrently whenever `events.price_cents` or `events.version` is nullable and the auto-created row (line 22 supplies only `event`, so every other column takes its default) leaves either NULL: a seat then sells for whatever was paid.

**Fix direction:** after line 23, `if not found then raise exception 'NO_EVENT'; end if;` — and do not auto-create the event row inside the money path at all; a payment arriving for an event that doesn't exist is a condition to reject, not to bootstrap. If the upsert must stay, use `insert … on conflict (event) do update set event = excluded.event returning *` so the conflicting path actually takes the lock and waits. Additionally make the guards NULL-safe (`is distinct from`) so a missing value fails closed.

---

## F5 — Refund results are never checked, and refunds carry no idempotency key

**`handler.ts:4`, `handler.ts:18`, `handler.ts:21`** — **Severity: Medium**

`refunded: await refund(...)` embeds the refund's return value in a `200` response without ever inspecting it. If `refund` returns `false`, or an error object, or a "pending"/"failed" status, the handler still returns `ok: true` — terminal. The provider stops retrying, the money stays captured, the seat is not sold, and nothing re-attempts the refund. Buyer paid, got nothing, refund silently failed.

If instead `refund` *throws*, the exception propagates out of `onPaymentSucceeded` uncaught. Whatever the route wrapper does with that (most likely a 500) triggers a provider retry, which re-enters at line 3 and can call `refund(ev.paymentId, …)` a second time. `refund` is called with only the payment id and a reason string — no idempotency key — so whether a double refund is prevented depends entirely on the provider deduplicating by payment id. Two refunds of 5000 cents against one 5000-cent charge is money out the door.

**Fix direction:** check the refund result and return `500` when it didn't succeed; pass a deterministic idempotency key (e.g. `refund:${ev.paymentId}`) so retries collapse.

---

## F6 — `payment_id` uniqueness is load-bearing and invisible here

**`finalize.sql:14`, `finalize.sql:33–34`** — **Severity: Medium (unverifiable from the fixture)**

`select * into s … where payment_id = p_payment_id` is a plain `SELECT INTO`, not `SELECT INTO STRICT`. If two rows ever share a `payment_id`, plpgsql takes the first arbitrarily and raises nothing — the duplicate is invisible forever. The insert at line 33 has no `ON CONFLICT` clause, so the *only* thing preventing two sales rows for one payment is a unique index on `seat_sales.payment_id` in a schema file not present in this fixture.

F4's race produces exactly two sales rows for one seat; whether it can also produce two rows for one *payment* depends on that index existing. This is SKILL.md §7's shape — a correctness property asserted nowhere, checkable by nothing in the code under review.

**Fix direction:** confirm `create unique index … on seat_sales(payment_id)` exists, and add `on conflict (payment_id) do nothing` plus a re-read at line 33 so the constraint is handled rather than thrown.

---

## F7 — `markQuote` runs outside the sale's transaction

**`handler.ts:13`** — **Severity: Low**

The sale commits inside `finalizeSeat`; `markQuote(quote.id, "consumed")` is a separate round trip after it. If it fails, the sale stands while the quote remains `pending`. The retry path is mostly benign — a re-delivery hits the idempotency lookup at `finalize.sql:14` and returns the existing sale — *provided* F1 and F3 are fixed. As written, this is the state-divergence that F3's refund branch feeds on. Worth noting mainly because fixing F1/F3 makes it harmless, and not fixing them makes it a contributing cause.

---

## Verified clean — what I checked and found correct

Stating these plainly, because a checked-and-safe finding is worth as much as a defect:

- **`finalize.sql:28`, the amount check, is on the correct side of the idempotency lookup.** `p_paid_cents <> d.price_cents` runs at line 28, *after* the `seat_sales` lookup at line 14 — so a duplicate delivery whose amount was re-derived differently (a provider payload variant omitting tax, the real §2 defect) returns the existing sale at line 19 rather than falling into the price branch and refunding a funded sale. This specific version of the catalogued bug is **not** present. (What *is* present is the parallel version of it in the handler: F3.)
- **`finalize.sql:25`, the version check, is genuinely after the lock.** `select … for update` at line 23 re-reads the `events` row under READ COMMITTED, so the version compared at line 25 is the post-lock committed value, not a pre-lock snapshot. The serialization that makes "exactly one winner per version" work is real — the second buyer with `expectedVersion = 7` correctly loses once the first bumped it to 8. The defect is not this check; it's the *idempotency* check that wasn't given the same treatment (F1), and the path where the row isn't found at all (F4).
- **`finalize.sql:32` updates under the lock**, `where event = p_event` on the row just locked, so the version bump cannot be lost to a concurrent bump.
- **`handler.ts:20–22`, the `WRONG_PRICE` refund, is correct behaviour** for a genuine underpayment or overpayment: no sale was created (the exception rolled the transaction back), so refunding is the right terminal outcome. It inherits F5's unchecked-result problem but the branch logic itself is sound.
- **No shared fail-closed dependency (§4)** and **no platform-trust assumption (§8)** appears in these two files — there is no rate limiter, no IP extraction, no header trust. Nothing to flag; nothing to clear either.
- **Dual implementations (§6):** the price rule exists only in SQL here (`d.price_cents`), with no TypeScript mirror in the fixture. If one exists elsewhere, `references/verification.md` §"Proving two implementations agree" applies — but there's nothing in these files to compare.

---

## Summary

| # | Location | Defect | Severity |
|---|---|---|---|
| F1 | `finalize.sql:14` vs `:23` → `handler.ts:18` | Idempotency read before the lock, never re-read; duplicate delivery refunds a funded sale | **Critical** |
| F2 | `handler.ts:23` | Terminal `200` for every unclassified failure; transient DB error = money captured, no seat, no refund, no retry | **Critical** |
| F3 | `handler.ts:3–4` | Quote check before idempotency; duplicate delivery after `markQuote` refunds a completed sale | **High** |
| F4 | `finalize.sql:22–30` | Unchecked `found` + NULL guards; first-purchase race mints an unpriced sale and skips the version bump | **High** |
| F5 | `handler.ts:4, 18, 21` | Refund result unchecked and un-keyed; failed refund returns terminal, retry can double-refund | **Medium** |
| F6 | `finalize.sql:14, 33–34` | Non-STRICT `SELECT INTO` + no `ON CONFLICT`; relies on an unseen unique index | **Medium** |
| F7 | `handler.ts:13` | `markQuote` outside the sale transaction; feeds F3 | **Low** |

**Fix order.** F2 first — it is one line and it is the difference between "this payment is retried" and "this payment is gone." Then F1, because every other retry-based fix depends on the finalizer being genuinely re-entrant. Then F3 and F4.

**Before shipping any regression test for these,** mutation-test it per `references/verification.md`: reintroduce the exact defect, confirm the new test goes red, restore, confirm green. Both F1 and F4 are concurrency defects whose windows parallel load will not reliably hit — a passing test written without forcing the interleaving proves nothing, and is how every bug in this catalogue reached production through a green suite.
