// One payment id, one outcome: a payment can fund a takeover OR be refunded,
// never both. The sequential half of the race is easy to miss — a refund
// branch does not necessarily make the quote terminal, so before the SQL
// advisory-lock exclusion a second event id for the same payment could still
// finalize after a refund succeeded. These tests pin the memory mirror (which
// the Supabase adapter mirrors in SQL, proven in tests/pg).
import assert from "node:assert/strict";
import test from "node:test";
import {
  claimRefundAttempt,
  completeRefundAttempt,
  createQuote,
  getDomain,
  listSalesForDomain,
  markQuoteStatus,
  reconcileRefundProviderEvent,
  resetMemoryMarket,
  upsertProfile,
} from "../../src/lib/repo.ts";
import { processSucceededPayment } from "../../src/lib/takeover.ts";

test.beforeEach(() => resetMemoryMarket());

test("a payment with a refund intent can never fund a takeover", async () => {
  await upsertProfile("u-excl", "excl", null, null);
  const quote = await createQuote("exclusion.com", "u-excl");

  // A first event refunded this payment (e.g. amount re-derived tax-inclusive).
  const claim = await claimRefundAttempt({
    provider: "demo",
    paymentId: "pi-exclusion-1",
    eventId: "evt-refund-1",
    reason: "amount_mismatch",
    amountCents: 590,
  });
  assert.equal(claim.claimed, true, "the refund intent is recorded");

  // A second event id for the SAME payment, now with the correct amount.
  const out = await processSucceededPayment({
    provider: "demo",
    eventId: "evt-success-2",
    paymentId: "pi-exclusion-1",
    quoteId: quote.id,
    paidCents: quote.nextPriceCents,
  });
  assert.equal(out.outcome, "failed");
  assert.equal(out.reason, "PAYMENT_ALREADY_REFUNDED");
  assert.notEqual(out.refunded, true, "must not refund twice");
  assert.equal((await getDomain("exclusion.com"))?.holderHandle ?? null, null, "no takeover");
  assert.equal((await listSalesForDomain("exclusion.com")).length, 0, "no sale");
});

test("a payment that funded a takeover is never refundable", async () => {
  await upsertProfile("u-excl2", "excl2", null, null);
  const quote = await createQuote("exclusion2.com", "u-excl2");

  const out = await processSucceededPayment({
    provider: "demo",
    eventId: "evt-success-1",
    paymentId: "pi-exclusion-2",
    quoteId: quote.id,
    paidCents: quote.nextPriceCents,
  });
  assert.equal(out.outcome, "processed");

  const claim = await claimRefundAttempt({
    provider: "demo",
    paymentId: "pi-exclusion-2",
    eventId: "evt-refund-2",
    reason: "stale_quote",
    amountCents: quote.nextPriceCents,
  });
  assert.equal(claim.claimed, false);
  assert.equal(claim.status, "already_finalized");
  assert.match(claim.lastError ?? "", /sale_exists/);
});

// Dodo does not document an Idempotency-Key on POST /refunds, so an
// indeterminate outcome (timeout/abort/network/unreadable 200) must park the
// ledger for manual reconciliation instead of retrying into a double refund.
test("an indeterminate provider refund parks the payment in manual_review", async () => {  const realFetch = globalThis.fetch;
  process.env.DODO_PAYMENTS_API_KEY = "dodo-indeterminate-test";
  try {
    globalThis.fetch = (async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as unknown as typeof fetch;

    await upsertProfile("u-ind", "ind", null, null);
    const quote = await createQuote("indeterminate.com", "u-ind");
    await markQuoteStatus(quote.id, "cancelled"); // terminal quote -> refund path

    const out = await processSucceededPayment({
      provider: "dodo",
      eventId: "evt-ind-1",
      paymentId: "pay_indeterminate_1",
      quoteId: quote.id,
      paidCents: quote.nextPriceCents,
    });
    assert.equal(out.outcome, "failed");
    assert.equal(out.reason, "quote_cancelled");
    assert.equal(out.refunded, false);
    assert.equal(out.manualReview, true, "indeterminate must be terminal, not retryable");

    const again = await claimRefundAttempt({
      provider: "dodo",
      paymentId: "pay_indeterminate_1",
      eventId: "evt-ind-2",
      reason: "quote_cancelled",
      amountCents: quote.nextPriceCents,
    });
    assert.equal(again.claimed, false);
    assert.equal(again.status, "manual_review", "the ledger must not grant another automatic attempt");
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.DODO_PAYMENTS_API_KEY;
  }
});

// A definitively failed refund must not park the payment forever: the provider
// answered without refunding, so a later correct payment may still fund the
// sale. Live intents (attempting/succeeded/manual_review) still block.
test("a failed refund does not block a later takeover", async () => {
  await upsertProfile("u-failed", "failed", null, null);
  const quote = await createQuote("failed-refund.com", "u-failed");
  const paymentId = "pi-failed-refund";

  const claim = await claimRefundAttempt({
    provider: "demo",
    paymentId,
    eventId: "evt-failed-1",
    reason: "stale_quote",
    amountCents: quote.nextPriceCents,
  });
  assert.equal(claim.claimed, true);
  // The provider definitively refused: nothing moved.
  assert.equal(
    await completeRefundAttempt({
      provider: "demo",
      paymentId,
      claimToken: claim.claimToken!,
      status: "failed",
      error: "provider refused",
    }),
    true,
  );

  const out = await processSucceededPayment({
    provider: "demo",
    eventId: "evt-failed-2",
    paymentId,
    quoteId: quote.id,
    paidCents: quote.nextPriceCents,
  });
  assert.equal(out.outcome, "processed", "a definitively failed refund must not block the sale");
  assert.equal((await listSalesForDomain("failed-refund.com")).length, 1);
  assert.equal((await getDomain("failed-refund.com"))?.holderHandle, "failed");
});

// The reconciliation verdict must report a sale atomically with the ledger
// write, so a refund-after-sale contradiction always raises the operator alert.
test("reconcile reports saleExists for a refund recorded after the sale", async () => {
  await upsertProfile("u-ras", "ras", null, null);
  const quote = await createQuote("refund-after-sale.com", "u-ras");
  const out = await processSucceededPayment({
    provider: "demo",
    eventId: "evt-ras-1",
    paymentId: "pi-refund-after-sale",
    quoteId: quote.id,
    paidCents: quote.nextPriceCents,
  });
  assert.equal(out.outcome, "processed");

  const reconciled = await reconcileRefundProviderEvent({
    provider: "demo",
    paymentId: "pi-refund-after-sale",
    eventId: "evt-ras-refund",
    status: "succeeded",
    amountCents: quote.nextPriceCents,
  });
  assert.equal(reconciled.saleExists, true, "the contradiction is detected, not hidden");
  // The takeover is never auto-reversed by a provider refund event.
  assert.equal((await getDomain("refund-after-sale.com"))?.holderHandle, "ras");
  assert.equal((await listSalesForDomain("refund-after-sale.com")).length, 1);
});

test("reconcile reports no sale for a refund that never funded a takeover", async () => {
  const reconciled = await reconcileRefundProviderEvent({
    provider: "demo",
    paymentId: "pi-no-sale-refund",
    eventId: "evt-nsr-1",
    status: "succeeded",
  });
  assert.equal(reconciled.saleExists, false);
});
