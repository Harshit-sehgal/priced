// HTTP-level contract for POST /api/webhooks/payments, the money entry point.
// Everything else tested this route's parts in isolation (processSucceededPayment
// directly, parseStaleWebhookEvent directly); a wiring regression in the route
// itself — a dropped duplicate branch, a missing refund path, an unverified
// signature — could pass the whole suite. This drives the real handler in demo
// mode with correctly signed payloads.
import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import {
  claimRefundAttempt,
  createQuote,
  getDomain,
  getQuote,
  listSalesForDomain,
  resetMemoryMarket,
  upsertProfile,
} from "../../src/lib/repo.ts";
import { demoWebhookSecret } from "../../src/lib/demo-secret.ts";
import { STALE_IN_PROGRESS_MS, isStaleInProgress } from "../../src/lib/webhook-retry.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { POST: webhookPOST } = (await import("../../src/app/api/webhooks/payments/route.ts")) as any;

test.beforeEach(() => resetMemoryMarket());

function sign(payload: string): string {
  return createHmac("sha256", demoWebhookSecret()).update(payload).digest("hex");
}

function demoPayload(args: {
  eventId: string;
  paymentId: string;
  quoteId: string | null;
  domain: string;
  amountCents: string | number;
  type?: string;
}): string {
  return JSON.stringify({
    id: args.eventId,
    type: args.type ?? "payment_intent.succeeded",
    payment_intent: args.paymentId,
    metadata:
      args.quoteId === null
        ? undefined
        : { quote_id: args.quoteId, domain: args.domain, amount_cents: String(args.amountCents) },
  });
}

async function deliver(payload: string, signature = sign(payload)): Promise<Response> {
  return webhookPOST(
    new Request("http://localhost/api/webhooks/payments", {
      method: "POST",
      headers: { "content-type": "application/json", "x-demo-signature": signature },
      body: payload,
    }),
  ) as Promise<Response>;
}

async function seedQuote(handle: string, domain: string) {
  await upsertProfile(`u-${handle}`, handle, null, null);
  return createQuote(domain, `u-${handle}`);
}

test("webhook: a signed success finalizes once and a duplicate converges", async () => {
  const quote = await seedQuote("route", "webhook-route.com");
  const payload = demoPayload({
    eventId: "evt-route-1",
    paymentId: "pi-route-1",
    quoteId: quote.id,
    domain: quote.domain,
    amountCents: quote.nextPriceCents,
  });

  const res = await deliver(payload);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { received?: boolean; result?: { outcome?: string; saleId?: string } };
  assert.equal(body.received, true);
  assert.equal(body.result?.outcome, "processed");
  assert.ok(body.result?.saleId);
  assert.equal((await getQuote(quote.id))?.status, "consumed");
  assert.equal((await getDomain(quote.domain))?.holderHandle, "route");

  // Same event id: recorded once, acknowledged without reprocessing.
  const replay = await deliver(payload);
  assert.equal(replay.status, 200);
  const replayBody = (await replay.json()) as { duplicate?: boolean };
  assert.equal(replayBody.duplicate, true);

  // Different event id, same payment: resolved against the sale ledger.
  const second = demoPayload({
    eventId: "evt-route-2",
    paymentId: "pi-route-1",
    quoteId: quote.id,
    domain: quote.domain,
    amountCents: quote.nextPriceCents,
  });
  const secondRes = await deliver(second);
  assert.equal(secondRes.status, 200);
  const secondBody = (await secondRes.json()) as { result?: { outcome?: string } };
  assert.equal(secondBody.result?.outcome, "duplicate");
  assert.equal((await listSalesForDomain(quote.domain)).length, 1, "one sale per payment");
});

test("webhook: an invalid signature is rejected before any processing", async () => {
  const quote = await seedQuote("sig", "webhook-sig.com");
  const payload = demoPayload({
    eventId: "evt-sig-1",
    paymentId: "pi-sig-1",
    quoteId: quote.id,
    domain: quote.domain,
    amountCents: quote.nextPriceCents,
  });
  const res = await deliver(payload, "0".repeat(64));
  assert.equal(res.status, 400);
  assert.equal((await listSalesForDomain(quote.domain)).length, 0);
});

test("webhook: an oversized body is rejected before parsing", async () => {
  const res = await deliver(JSON.stringify({ pad: "x".repeat(70_000) }));
  assert.equal(res.status, 413);
});

test("webhook: a success without quote metadata is refunded, never a sale", async () => {
  const payload = demoPayload({
    eventId: "evt-nometa-1",
    paymentId: "pi-nometa-1",
    quoteId: null,
    domain: "irrelevant.com",
    amountCents: 500,
  });
  const res = await deliver(payload);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { result?: { outcome?: string; refunded?: boolean; reason?: string } };
  assert.equal(body.result?.outcome, "failed");
  assert.equal(body.result?.refunded, true);
  assert.equal(body.result?.reason, "missing_quote_metadata");
});

test("webhook: a failed payment event is acknowledged without side effects", async () => {
  const quote = await seedQuote("fail", "webhook-fail.com");
  const payload = demoPayload({
    eventId: "evt-fail-1",
    paymentId: "pi-fail-1",
    quoteId: quote.id,
    domain: quote.domain,
    amountCents: quote.nextPriceCents,
    type: "payment_intent.payment_failed",
  });
  const res = await deliver(payload);
  assert.equal(res.status, 200);
  assert.equal((await listSalesForDomain(quote.domain)).length, 0);
  assert.equal((await getQuote(quote.id))?.status, "active");
});

test("webhook: a success for a refund-intent payment is acked, never a sale", async () => {
  const quote = await seedQuote("already", "webhook-already.com");
  // A prior event (e.g. an amount-mismatch variant) already refunded this
  // payment. The second event must not mint a sale on top of the refund.
  const claim = await claimRefundAttempt({
    provider: "demo",
    paymentId: "pi-already-1",
    eventId: "evt-refund-first",
    reason: "amount_mismatch",
    amountCents: quote.nextPriceCents + 90,
  });
  assert.equal(claim.claimed, true);

  const payload = demoPayload({
    eventId: "evt-already-success",
    paymentId: "pi-already-1",
    quoteId: quote.id,
    domain: quote.domain,
    amountCents: quote.nextPriceCents,
  });
  const res = await deliver(payload);
  assert.equal(res.status, 200, "must be acknowledged, not retried forever");
  const body = (await res.json()) as { result?: { reason?: string; refunded?: boolean } };
  assert.equal(body.result?.reason, "PAYMENT_ALREADY_REFUNDED");
  assert.notEqual(body.result?.refunded, true);
  assert.equal((await listSalesForDomain(quote.domain)).length, 0, "no sale on a refunded payment");
  assert.equal((await getDomain(quote.domain))?.holderUserId ?? null, null);
});

// The duplicate handler used to acknowledge a `received` row forever, so a
// crashed first delivery (or a failed terminal status write) left a paid
// payment permanently unprocessed. Rows older than the provider timeout window
// must re-enter processing.
test("isStaleInProgress: only rows older than the provider window are re-entered", () => {
  const now = Date.now();
  assert.equal(isStaleInProgress(new Date(now - 1_000).toISOString(), now), false);
  assert.equal(isStaleInProgress(new Date(now - STALE_IN_PROGRESS_MS - 1).toISOString(), now), true);
  assert.equal(isStaleInProgress(null, now), true, "a missing timestamp is treated as abandoned");
  assert.equal(isStaleInProgress("not-a-date", now), true);
});

test("webhook: a refund event is reconciled and acknowledged", async () => {
  const quote = await seedQuote("refevt", "webhook-refund-event.com");
  const payload = demoPayload({
    eventId: "evt-refund-event",
    paymentId: "pi-refund-event",
    quoteId: quote.id,
    domain: quote.domain,
    amountCents: quote.nextPriceCents,
    type: "charge.refunded",
  });
  const res = await deliver(payload);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { refund?: string };
  assert.equal(body.refund, "charge.refunded");
  assert.equal((await listSalesForDomain(quote.domain)).length, 0, "a refund never mints a sale");
});
