// A duplicate webhook delivery must never refund a sale that is already funded.
//
// processSucceededPayment used to run the amount check BEFORE calling
// finalizeTakeover, which is where the sales-by-payment-id idempotency lives.
// So a second delivery for a payment that had already produced a sale, whose
// amount was re-derived differently, landed in `amount_mismatch` and refunded:
// the buyer kept the tag AND got their money back.
//
// The amount check exists to stop a wrong-priced payment MINTING a sale. On a
// consumed quote it cannot do that, so running it first was pure downside.
// This is the same defect migration 20260912000001 closed in SQL — a check
// taken before the idempotency lookup is not a safe check.
//
// Re-derivation really can differ between deliveries: dodoAmountFromPayload
// deliberately tolerates a payload variant that omits `tax`, which yields a
// tax-inclusive total instead of the pre-tax market price.
import assert from "node:assert/strict";
import test from "node:test";
import {
  resetMemoryMarket,
  upsertProfile,
  createQuote,
  markQuoteStatus,
  getQuote,
  getDomain,
  listSalesForDomain,
} from "../../src/lib/repo.ts";
import { processSucceededPayment } from "../../src/lib/takeover.ts";

test.beforeEach(() => resetMemoryMarket());

/** Drive one delivery of the same payment id. */
async function deliver(quoteId: string, eventId: string, paidCents: number | null) {
  return processSucceededPayment({
    provider: "demo",
    eventId,
    paymentId: "pi-dupe-safety",
    quoteId,
    paidCents,
  });
}

test("a duplicate delivery with a re-derived amount does not refund the funded sale", async () => {
  await upsertProfile("u-amy", "amy", null, null);
  const quote = await createQuote("dupe-amount.com", "u-amy");

  const first = await deliver(quote.id, "evt-1", quote.nextPriceCents);
  assert.equal(first.outcome, "processed");
  assert.equal((await getQuote(quote.id))?.status, "consumed");

  // Second delivery of the SAME payment, amount re-derived tax-inclusive.
  const second = await deliver(quote.id, "evt-2", quote.nextPriceCents + 90);
  assert.notEqual(second.reason, "amount_mismatch", "must not refund an already-funded sale");
  assert.notEqual(second.refunded, true, "no refund may be issued for a committed sale");

  // Third delivery asserting no amount at all.
  const third = await deliver(quote.id, "evt-3", null);
  assert.notEqual(third.reason, "amount_mismatch");
  assert.notEqual(third.refunded, true);

  // The market is untouched throughout.
  assert.equal((await getDomain("dupe-amount.com"))?.holderHandle, "amy");
  assert.equal((await listSalesForDomain("dupe-amount.com")).length, 1, "exactly one sale");
});

test("an exact duplicate delivery converges on duplicate, not a second sale", async () => {
  await upsertProfile("u-ben", "ben", null, null);
  const quote = await createQuote("dupe-exact.com", "u-ben");

  const first = await deliver(quote.id, "evt-a", quote.nextPriceCents);
  assert.equal(first.outcome, "processed");

  const second = await deliver(quote.id, "evt-b", quote.nextPriceCents);
  assert.equal(second.outcome, "duplicate");
  assert.equal(second.saleId, first.saleId, "same sale, not a new one");
  assert.equal((await listSalesForDomain("dupe-exact.com")).length, 1);
});

// The relaxation is scoped to consumed quotes ONLY. A FIRST delivery carrying
// the wrong amount must still fail closed and refund — that is the check doing
// the job it exists for.
test("a first delivery with a wrong amount still refunds", async () => {
  await upsertProfile("u-cara", "cara", null, null);
  const quote = await createQuote("dupe-firstwrong.com", "u-cara");

  const result = await deliver(quote.id, "evt-w", quote.nextPriceCents - 100);
  assert.equal(result.outcome, "failed");
  assert.equal(result.reason, "amount_mismatch");
  assert.equal(result.refunded, true);
  assert.equal((await listSalesForDomain("dupe-firstwrong.com")).length, 0, "no sale minted");
});

test("a first delivery asserting no amount still fails closed", async () => {
  await upsertProfile("u-dan", "dan", null, null);
  const quote = await createQuote("dupe-firstnull.com", "u-dan");

  const result = await deliver(quote.id, "evt-n", null);
  assert.equal(result.outcome, "failed");
  assert.equal(result.reason, "amount_mismatch");
  assert.equal((await listSalesForDomain("dupe-firstnull.com")).length, 0, "no sale on an unverified sum");
});

// A simultaneous challenger that LOSES used to mark the quote `stale` after
// the winner's `consumed` write, and the next duplicate delivery of the
// winner's payment then read a terminal quote and refunded the funded sale.
// Two independent fixes now stand in the way: markQuoteStatus refuses to
// downgrade `consumed`, and processSucceededPayment resolves the payment id
// against the sales ledger before any refund branch. This test pins the first.
test("a losing challenger cannot downgrade a consumed quote to stale", async () => {
  await upsertProfile("u-ella", "ella", null, null);
  const quote = await createQuote("dupe-stale.com", "u-ella");

  const first = await deliver(quote.id, "evt-1", quote.nextPriceCents);
  assert.equal(first.outcome, "processed");
  assert.equal((await getQuote(quote.id))?.status, "consumed");

  // The losing challenger's terminal write, landing on the winner's quote.
  await markQuoteStatus(quote.id, "stale");
  assert.equal((await getQuote(quote.id))?.status, "consumed", "consumed is terminal");

  const replay = await deliver(quote.id, "evt-2", quote.nextPriceCents);
  assert.equal(replay.outcome, "duplicate", "the funded sale is resolved idempotently");
  assert.notEqual(replay.refunded, true, "no refund may be issued for a committed sale");
  assert.equal((await getDomain("dupe-stale.com"))?.holderHandle, "ella");
  assert.equal((await listSalesForDomain("dupe-stale.com")).length, 1, "exactly one sale");
});

test("a duplicate for an unknown quote still resolves to the funded sale, not a refund", async () => {
  await upsertProfile("u-finn", "finn", null, null);
  const quote = await createQuote("dupe-unknown.com", "u-finn");

  const first = await deliver(quote.id, "evt-1", quote.nextPriceCents);
  assert.equal(first.outcome, "processed");

  const replay = await deliver("00000000-0000-4000-8000-000000000000", "evt-2", quote.nextPriceCents);
  assert.equal(replay.outcome, "duplicate");
  assert.notEqual(replay.refunded, true);
  assert.equal((await listSalesForDomain("dupe-unknown.com")).length, 1);
});

// The sale-first lookup was added to cover exactly this: a buyer moderated
// AFTER a successful purchase. The profile checks sit below the idempotency
// lookup; if they move above it, a duplicate delivery of a funded payment hits
// `buyer_suspended` and refunds a sale that exists (tag kept AND money back).
// The memory adapter hands back the live profile row, so a moderation write is
// simulated by mutating it — the same pattern adapter-parity.test.ts uses.
test("a buyer suspended after purchase is not refunded by a duplicate delivery", async () => {
  const { getProfileById } = await import("../../src/lib/repo.ts");
  await upsertProfile("u-sus", "sus", null, null);
  const quote = await createQuote("dupe-suspended.com", "u-sus");

  const first = await deliver(quote.id, "evt-1", quote.nextPriceCents);
  assert.equal(first.outcome, "processed");

  // Moderation lands between deliveries.
  const profile = (await getProfileById("u-sus"))!;
  profile.suspendedAt = new Date().toISOString();

  const replay = await deliver(quote.id, "evt-2", quote.nextPriceCents);
  assert.equal(replay.outcome, "duplicate", "the funded sale is resolved before the profile check");
  assert.notEqual(replay.refunded, true, "suspension must not refund a completed purchase");
  assert.equal((await getDomain("dupe-suspended.com"))?.holderHandle, "sus");
  assert.equal((await listSalesForDomain("dupe-suspended.com")).length, 1);
});

// A delivery whose metadata is dropped entirely (quoteId null) must still
// resolve against the sales ledger. Before the idempotency-first lookup this
// went straight to `missing_quote_metadata` and refunded the funded sale.
test("a duplicate with no quote metadata resolves to the funded sale, not a refund", async () => {
  const { seedDemoMarket } = await import("../../src/lib/repo.ts");
  seedDemoMarket([{ domain: "dupe-metadata.com", holderHandle: "hana", priceCents: 500 }]);

  const replay = await processSucceededPayment({
    provider: "demo",
    eventId: "evt-meta",
    paymentId: "demo-dupe-metadata.com-500",
    quoteId: null,
    paidCents: null,
  });
  assert.equal(replay.outcome, "duplicate");
  assert.notEqual(replay.refunded, true);
  assert.equal((await listSalesForDomain("dupe-metadata.com")).length, 1);
});

test("reusing a payment id with conflicting args alerts and never refunds", async () => {
  await upsertProfile("u-gina", "gina", null, null);
  const quote = await createQuote("dupe-conflict.com", "u-gina");
  const first = await deliver(quote.id, "evt-1", quote.nextPriceCents);
  assert.equal(first.outcome, "processed");

  // Same payment id, different amount: a critical conflict, not a refund.
  const conflict = await deliver(quote.id, "evt-2", quote.nextPriceCents + 500);
  assert.equal(conflict.outcome, "failed");
  assert.equal(conflict.reason, "IDEMPOTENCY_CONFLICT");
  assert.notEqual(conflict.refunded, true);
  assert.equal((await listSalesForDomain("dupe-conflict.com")).length, 1);
});
