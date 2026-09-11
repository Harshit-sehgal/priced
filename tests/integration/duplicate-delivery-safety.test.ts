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
