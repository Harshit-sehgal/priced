import assert from "node:assert/strict";
import test from "node:test";
import { processSucceededPayment } from "../../src/lib/takeover.ts";
import {
  createQuote,
  finalizeTakeover,
  getDomain,
  getQuote,
  resetMemoryMarket,
  seedDemoMarket,
  upsertProfile,
} from "../../src/lib/repo.ts";

test.beforeEach(() => resetMemoryMarket());

test("first claim stores a selected offer above the $5 floor", async () => {
  await upsertProfile("u-first", "first", null, null);
  const quote = await createQuote("offer-first.com", "u-first", 1250);

  assert.equal(quote.minimumPriceCents, 500);
  assert.equal(quote.nextPriceCents, 1250);
  assert.equal((await getQuote(quote.id))?.nextPriceCents, 1250);

  const result = await finalizeTakeover({
    domain: quote.domain,
    buyerUserId: quote.buyerUserId,
    buyerHandle: "first",
    expectedVersion: quote.expectedVersion,
    paidCents: quote.nextPriceCents,
    providerPaymentId: "pay-offer-first",
  });
  assert.equal(result.ok, true);
  assert.equal((await getDomain(quote.domain))?.priceCents, 1250);
});

test("takeover floor is current price plus the required increment, but a higher offer wins", async () => {
  seedDemoMarket([{ domain: "offer-takeover.com", holderHandle: "old", priceCents: 500 }]);
  await upsertProfile("u-next", "next", null, null);
  const quote = await createQuote("offer-takeover.com", "u-next", 2500);

  assert.equal(quote.minimumPriceCents, 1000);
  assert.equal(quote.nextPriceCents, 2500);
  const result = await finalizeTakeover({
    domain: quote.domain,
    buyerUserId: quote.buyerUserId,
    buyerHandle: "next",
    expectedVersion: quote.expectedVersion,
    paidCents: quote.nextPriceCents,
    providerPaymentId: "pay-offer-takeover",
  });
  assert.equal(result.ok, true);
  assert.equal((await getDomain(quote.domain))?.priceCents, 2500);
});

test("the selected higher offer is the exact amount accepted by the webhook path", async () => {
  await upsertProfile("u-webhook-offer", "webhook-offer", null, null);
  const quote = await createQuote("offer-webhook.com", "u-webhook-offer", 1750);
  const result = await processSucceededPayment({
    provider: "demo",
    eventId: "evt-offer-webhook",
    paymentId: "pay-offer-webhook",
    quoteId: quote.id,
    paidCents: 1750,
  });

  assert.equal(result.outcome, "processed");
  assert.equal((await getDomain(quote.domain))?.priceCents, 1750);
});

test("quote creation rejects an offer below the server-computed floor", async () => {
  seedDemoMarket([{ domain: "offer-floor.com", holderHandle: "old", priceCents: 500 }]);
  await upsertProfile("u-low", "low", null, null);
  await assert.rejects(
    () => createQuote("offer-floor.com", "u-low", 999),
    (error: unknown) => error instanceof Error && error.message === "OFFER_TOO_LOW",
  );
});
