# Payment Review — fixture-a (`finalize.sql`, `handler.ts`)

Scope: money-loss, double-spend, and incorrect-refund defects in the seat finalization path.
Invariant under test: *a buyer pays for a seat; a signed webhook finalizes it; exactly one buyer wins a given seat version; the merchant neither keeps money without delivering a seat nor delivers a seat and returns the money.*

Findings are ordered by severity.

---

## C1 — Missing quote causes a refund of an already-finalized sale (seat kept **and** money returned)
**`handler.ts:3-4`**

```ts
const quote = await getQuote(ev.quoteId);
if (!quote) return { ok: true, refunded: await refund(ev.paymentId, "unknown_quote") };
```

The handler decides to refund based solely on quote lookup, **before** consulting `seat_sales`. The SQL function has a payment-id idempotency path (`finalize.sql:14-20`) that would have returned the existing sale — but that path is unreachable once `getQuote` returns null.

**Failure scenario (provider retry after consumption):**
1. `pay_1` for `quote_9` (event `E`, buyer `B`, 5000 cents) is delivered. `finalize_seat` inserts sale `S1`. `markQuote(quote_9, "consumed")` runs. Returns 200.
2. The provider's at-least-once delivery fires `pay_1` again 40s later (a 200 that the provider did not record, a dual-region dispatch, or a manual replay from the dashboard).
3. `getQuote("quote_9")` returns `null` — because the lookup filters on status `pending`/`open` (consumed quotes are hidden), or because quotes are TTL-purged, or because the row was archived.
4. → `refund(pay_1, "unknown_quote")`.

**Outcome:** buyer `B` holds seat `S1` in `seat_sales` and has been refunded 5000 cents in full. Direct, silent, unrecoverable loss of the full ticket price plus non-refundable processor fees. Nothing alerts, because the response is `ok: true`.

The same path fires whenever `getQuote` returns `null` for a transient reason (read replica lag, a DB error swallowed into `null`), refunding perfectly good payments.

**Severity: Critical.**

**Fix direction:** never refund on the basis of quote state. Look up `seat_sales` by `payment_id` first; if a sale exists for this payment, return it idempotently. Only refund when the DB positively confirms no sale exists for that payment id.

---

## C2 — Concurrent duplicate delivery of the *same* payment is misread as "someone else took the seat" and refunded
**`finalize.sql:14-20` (non-locking idempotency read) → `finalize.sql:25-27` → `handler.ts:16-18`**

The idempotency probe is a plain `select` with no lock and no unique-constraint backstop; the serialization point is the `for update` on `events` at line 23, which is taken *after* the probe.

**Failure scenario (two concurrent deliveries of one payment):**
1. Provider delivers `pay_1` (quote `q1`, `expectedVersion = 7`, 5000 cents) twice, ~50 ms apart — the ordinary at-least-once duplicate, or two webhook workers pulling the same queue item.
2. **T1** and **T2** both execute line 14. `seat_sales` has no row for `pay_1`, so `found` is false in **both**. No conflict is detected.
3. T1 reaches `for update` (line 23), sees `version = 7`, matches `p_expected_version = 7`, bumps to 8 (line 32), inserts sale `S1`, commits.
4. T2 was blocked on the same `for update`. It unblocks, re-reads under READ COMMITTED, and sees `version = 8`. `8 <> 7` → `raise exception 'STALE_QUOTE'` (line 26).
5. `handler.ts:16` interprets `STALE_QUOTE` as *"Someone else took the seat first; return the money"* and calls `refund(pay_1, "stale_quote")` — on the **same payment id** that just successfully bought the seat.

**Outcome:** identical to C1 — the buyer keeps the seat and gets a full refund. This one needs no quote expiry at all; plain duplicate webhook delivery is enough, so it will fire in normal operation.

Two aggravating details:
- If `seat_sales.payment_id` carries no unique index (none is visible in the fixture, and the function's logic does not depend on one), the probe is the *only* duplicate defense, and it is racy by construction.
- Both transactions can also reach `refund()` for the same `payment_id` if a third delivery arrives, giving the provider two refund requests for one charge with no idempotency key (see H6).

**Severity: Critical.**

**Fix direction:** add `unique (payment_id)` on `seat_sales` and treat the resulting `unique_violation` as the idempotent-replay path (re-select and return the existing sale), rather than relying on a pre-read. Independently, `handler.ts` must confirm no sale exists for `ev.paymentId` before mapping `STALE_QUOTE` to a refund.

---

## C3 — Auto-created event row makes both the version and price guards vanish (NULL three-valued logic) — seat sold for any amount
**`finalize.sql:22-30`**

```sql
insert into public.events(event) values (p_event) on conflict (event) do nothing;
select * into d from public.events where event = p_event for update;

if d.version <> p_expected_version then raise exception 'STALE_QUOTE'; end if;
if p_paid_cents <> d.price_cents then raise exception 'WRONG_PRICE'; end if;
```

Line 22 **creates the event on demand** from webhook-supplied data. A freshly created row has whatever `events.price_cents` defaults to — and unless the column is `not null` with a sane default (nothing in this function requires it to be), that is `NULL`.

In SQL, `p_paid_cents <> NULL` evaluates to `NULL`, which is **not true**, so the `if` does not fire. The `WRONG_PRICE` guard is silently skipped. The same applies to `d.version <> p_expected_version` if `version` is nullable.

**Failure scenario:**
1. Attacker (or a typo in a client build) creates a quote / payment referencing event string `"E-2026-GALA "` — a trailing space, a case variant, or any event id not yet in `events`.
2. They pay **1 cent**. Webhook arrives with `paidCents = 1`, `expectedVersion = 0`.
3. Line 22 inserts `events('E-2026-GALA ')` with `price_cents = NULL`.
4. Line 28: `1 <> NULL` → `NULL` → guard skipped. Line 25 likewise if `version` is null.
5. Line 33 inserts a valid row into `seat_sales` with `price_cents = 1`.

**Outcome:** a confirmed, auditable seat sale for 1 cent against a 5000-cent product; the price authority (`events.price_cents`) was never consulted. Even with a `not null default 0` on `price_cents`, the outcome is only marginally better: the function happily sells seats for any event string a payer can name, at 0 cents.

Finalization is the wrong place to create the pricing authority record: **the event must already exist, or the function must fail**. There is also no `found`/`not null` check after the `select into` at line 23 — if the row is absent (a concurrent delete, or an `on conflict` target mismatch), `d` is all-NULL and *every* guard is skipped before the sale is inserted.

**Severity: Critical.**

**Fix direction:** delete line 22. Replace line 23 with a locked select followed by `if not found then raise exception 'UNKNOWN_EVENT'; end if;`, and use `is distinct from` for both comparisons so NULL can never mean "passed". Add `not null` to `events.version` and `events.price_cents`.

---

## H4 — Every unclassified failure is converted into a terminal 200: money captured, no seat, no refund, no retry
**`handler.ts:23`**

```ts
return { ok: true, alert: outcome.code };
```

Per the file's own contract on line 1 (`200 = terminal, 500 = provider retries`), this line tells the provider *"handled, never send this again"* for every outcome the handler does not recognize.

**Failure scenario:**
1. `pay_1` (5000 cents, event `E`) arrives during a Postgres failover / connection-pool exhaustion / statement timeout. `finalizeSeat` returns `{ ok: false, code: "DB_TIMEOUT" }` (or `PGRST…`, or `INVALID_PAYMENT_ID`, or `IDEMPOTENCY_CONFLICT`).
2. Line 23 returns `{ ok: true, alert: "DB_TIMEOUT" }` → 200.
3. The provider marks the webhook delivered and never retries.

**Outcome:** the charge is captured and settled, no `seat_sales` row exists, no refund is issued, and the buyer has no seat. The only trace is an `alert` field in an HTTP response body that nobody reads. This is the classic "money in limbo" case, and it hits hardest during exactly the incidents that produce the most traffic.

Note this also covers `IDEMPOTENCY_CONFLICT` (`finalize.sql:17`) — a replay whose event/buyer/amount disagrees with the recorded sale is a serious integrity signal, and it is answered with a 200 and no refund.

**Severity: High.**

**Fix direction:** default to **retryable** — return 500 (or rethrow) for unknown and transient codes so the provider redelivers, and enumerate terminal codes explicitly. Route `IDEMPOTENCY_CONFLICT` to a hard alert plus a hold on the payment, never to silent success.

---

## H5 — No currency validation anywhere; price is compared as a bare integer
**`handler.ts:9` (`paidCents: ev.amountCents`) and `finalize.sql:28`**

`ev.amountCents` is passed straight through, and the SQL compares it to `d.price_cents` as a plain `bigint`. Neither layer reads a currency field.

**Failure scenario:** the event is priced at 5000 (USD cents, $50.00). A checkout session is created — or the provider account is configured — in a zero-decimal or weaker currency: 5000 JPY (≈$32), 5000 KRW (≈$3.60), 5000 HUF (≈$14). The webhook reports `amountCents = 5000`; line 28 passes; the seat is sold.

**Outcome:** seats sold at a fraction of list price, at scale, with every guard reporting success. The idempotency comparison at line 16 shares the flaw — a replay in a different currency with the same integer amount is accepted as identical.

**Severity: High** (trivially exploitable if checkout currency is client-influenced; otherwise a latent misconfiguration hazard).

**Fix direction:** store and compare `(amount, currency)` as a pair — add `currency` to `events`, `seat_sales`, and the function signature, and reject any mismatch.

---

## H6 — `refund()` results are never checked, and refunds carry no idempotency key
**`handler.ts:4, 18, 21`**

All three call sites do `refunded: await refund(...)` inside a `{ ok: true }` literal. The return value is embedded in the response and never inspected.

**Two failure modes:**

*(a) Refund fails silently.* `refund()` returns `false` / `{ status: "failed" }` because the provider rejects it (insufficient platform balance, charge disputed, refund window closed). The handler still returns `ok: true` → 200 terminal. The buyer got neither the seat (`STALE_QUOTE` path) nor the money. Silent, permanent, and invisible because the failure is serialized into a field nobody alerts on.

*(b) Double refund.* `refund()` throws (network timeout after the provider already accepted the refund). The exception propagates out of `onPaymentSucceeded` → 500 → the provider retries the webhook → the handler re-runs, re-derives the same branch, and calls `refund(pay_1, …)` a second time. With no idempotency key on the refund call, a provider that permits multiple partial refunds against one charge will issue a second one, and the merchant refunds up to 2× the charge for a single sale.

**Severity: High.**

**Fix direction:** pass a deterministic idempotency key (e.g. `refund:{paymentId}`) on every refund, persist a refund record before/with the call, assert success, and fail loudly (500 + alert) when a refund does not confirm.

---

## M7 — `seat_sales` does not record the version it won, so the "exactly one winner per seat version" invariant is unenforceable and unauditable
**`finalize.sql:32-34`**

The winning version is consumed by the `update` on line 32 but never written to the sale row. Consequences:

- No `unique (event, version)` constraint on `seat_sales` is possible, so the entire invariant rests on a single procedural path — the `for update` at line 23 plus the bump at line 32. Any other writer (an admin backfill, a migration, a future RPC, a `security definer` helper) that inserts into `seat_sales` without taking that lock silently double-sells a seat, and the database will not object.
- After the fact, you cannot reconcile a sale to the seat version it purchased, which is precisely the evidence needed to settle a "we both paid for seat N" dispute.
- The version bump on line 32 is also unconditional and unlogged: any *other* process that bumps `events.version` (a price edit, an admin tool) will push every outstanding quote into `STALE_QUOTE` and — via C2/`handler.ts:18` — into refunds of successful payments.

**Severity: Medium** (defense-in-depth gap that converts any future second writer into a direct double-sell).

**Fix direction:** add `version bigint not null` to `seat_sales`, write `p_expected_version` into it, and add `unique (event, version)`.

---

## M8 — `markQuote` is outside the finalizing transaction
**`handler.ts:12-14`**

The sale commits in Postgres; the quote is marked `consumed` afterwards over a separate call. If the process dies between them, the quote stays open while the sale exists. The SQL payment-id idempotency path (`finalize.sql:14-20`) does cover an identical replay of the *same* payment, so this is not itself a double-sell — but it leaves an open quote whose `expectedVersion` is now stale, and every subsequent payment against it lands on the `STALE_QUOTE` → refund branch. Combined with C1/C2 that becomes another route to "seat sold, money returned."

**Severity: Medium.**

**Fix direction:** consume the quote inside `finalize_seat` (pass `p_quote_id` and update it in the same transaction as the sale insert).

---

## L9 — No visible signature verification, and the payment is never tied to the quote's buyer
**`handler.ts:1-9`**

The header comment asserts "Signed webhook", but nothing in this function verifies a signature; `ev.amountCents`, `ev.paymentId`, and `ev.quoteId` are all trusted as authentic. If verification does not happen in the (unshown) transport layer, C3 plus a forged event is a free seat. Separately, the handler never checks that the payer on `ev` matches `quote.buyerId` — a caller who learns another user's `quoteId` can pay and have the seat assigned to that other user, which is a griefing/laundering vector rather than direct loss.

**Severity: Low as written, Critical if the signature check is genuinely absent upstream — please confirm the transport layer.**

---

## Summary

| # | Location | Defect | Severity |
|---|---|---|---|
| C1 | `handler.ts:4` | Refunds a completed sale when the quote is gone | Critical |
| C2 | `finalize.sql:14-20`, `handler.ts:16-18` | Racy idempotency probe → duplicate delivery refunded as `STALE_QUOTE` | Critical |
| C3 | `finalize.sql:22-30` | On-demand event creation + NULL comparisons disable price and version guards | Critical |
| H4 | `handler.ts:23` | Unknown/transient errors returned as terminal 200 — money captured, no seat | High |
| H5 | `handler.ts:9`, `finalize.sql:28` | No currency check on the price comparison | High |
| H6 | `handler.ts:4,18,21` | Refund result unchecked; no refund idempotency key | High |
| M7 | `finalize.sql:32-34` | Winning version not persisted; invariant unenforceable by constraint | Medium |
| M8 | `handler.ts:12-14` | Quote consumption not atomic with the sale | Medium |
| L9 | `handler.ts:1-9` | No signature verification or payer↔quote binding in this layer | Low / Critical if upstream check absent |

**The unifying bug:** the handler refunds based on *local, derived* state (is there a quote? did the version match?) instead of the *authoritative* question — **does a sale already exist for this `payment_id`?** C1, C2, H6, and M8 all collapse once that question is asked first, in the database, under a unique constraint. C3 and H5 are independent and let a seat be sold below price.
