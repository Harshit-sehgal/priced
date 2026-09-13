// Dodo Payments provider (user list items 2+3): Standard-Webhooks
// verification, event mapping, checkout body, refunds. Network is stubbed —
// no live Dodo calls.
import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import {
  DodoPaymentsProvider,
  getPaymentProvider,
  getProviderForEvent,
  listMemoryDisputes,
  recordPaymentDispute,
  refundIdempotencyKey,
  resetMemoryDisputes,
  UNVERIFIABLE_AMOUNT_CENTS,
} from "../../src/lib/payments.ts";

const ENV_KEYS = [
  "DODO_PAYMENTS_API_KEY",
  "DODO_PAYMENTS_MODE",
  "DODO_PAYMENTS_PRODUCT_ID",
  "DODO_PAYMENTS_WEBHOOK_KEY",
  "DODO_PAYMENTS_BASE_URL",
  "DODO_PAYMENTS_CURRENCY",
  "STRIPE_SECRET_KEY",
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

function useDodoEnv(): void {
  delete process.env.STRIPE_SECRET_KEY;
  process.env.DODO_PAYMENTS_API_KEY = "test-key";
  process.env.DODO_PAYMENTS_MODE = "test";
  process.env.DODO_PAYMENTS_PRODUCT_ID = "pdt_test_123";
  process.env.DODO_PAYMENTS_WEBHOOK_KEY = "test-webhook-secret-0123456789";
  delete process.env.DODO_PAYMENTS_BASE_URL;
  delete process.env.DODO_PAYMENTS_CURRENCY;
}

/** Sign + verify a Dodo payload with the current test env. */
function verify(raw: string, id: string, opts: { timestamp?: string } = {}) {
  const secret = process.env.DODO_PAYMENTS_WEBHOOK_KEY!;
  const ts = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  return new DodoPaymentsProvider().verifyWebhook(raw, signDodo(id, ts, raw, secret), {
    webhookId: id,
    webhookTimestamp: ts,
  });
}

function dodoPayment(data: Record<string, unknown>, type = "payment.succeeded"): string {
  return JSON.stringify({
    business_id: "biz_test",
    type,
    timestamp: new Date().toISOString(),
    data: { payload_type: "Payment", ...data },
  });
}

function signDodo(webhookId: string, timestamp: string, raw: string, secret: string): string {
  const sig = createHmac("sha256", secret).update(`${webhookId}.${timestamp}.${raw}`, "utf8").digest("base64");
  return `v1,${sig}`;
}

function succeededPayload(): { raw: string; quoteId: string } {
  const raw = JSON.stringify({
    business_id: "biz_test",
    type: "payment.succeeded",
    timestamp: new Date().toISOString(),
    data: {
      payload_type: "Payment",
      payment_id: "pay_test_001",
      total_amount: 94940,
      currency: "USD",
      metadata: { quote_id: "11111111-1111-4111-8111-111111111111", domain: "openai.com", amount_cents: "94940" },
    },
  });
  return { raw, quoteId: "11111111-1111-4111-8111-111111111111" };
}

test("dodo is the default provider when its key is set (stripe kept as fallback)", () => {
  const snap = snapshotEnv();
  try {
    useDodoEnv();
    process.env.STRIPE_SECRET_KEY = "sk_test_fallback";
    assert.equal(getPaymentProvider().name, "dodo");
    delete process.env.DODO_PAYMENTS_API_KEY;
    assert.equal(getPaymentProvider().name, "stripe");
  } finally {
    restoreEnv(snap);
  }
});

test("dodo webhook verifies and maps payment.succeeded", () => {
  const snap = snapshotEnv();
  try {
    useDodoEnv();
    const secret = process.env.DODO_PAYMENTS_WEBHOOK_KEY!;
    const provider = new DodoPaymentsProvider();
    const { raw, quoteId } = succeededPayload();
    const id = "wh_abc123";
    const ts = String(Math.floor(Date.now() / 1000));
    const res = provider.verifyWebhook(raw, signDodo(id, ts, raw, secret), { webhookId: id, webhookTimestamp: ts });
    assert.ok(res.ok, `expected ok, got ${JSON.stringify(res)}`);
    if (res.ok) {
      assert.equal(res.event.id, id);
      assert.equal(res.event.type, "payment.succeeded");
      assert.equal(res.event.paymentId, "pay_test_001");
      assert.equal(res.event.quoteId, quoteId);
      assert.equal(res.event.amountCents, 94940);
      assert.equal(res.event.status, "succeeded");
      assert.equal(res.event.currency, "USD");
      assert.equal(res.event.amountRejection, null);
      assert.equal(res.event.dispute, null);
    }
  } finally {
    restoreEnv(snap);
  }
});

test("dodo webhook rejects tampered payloads, missing headers and stale timestamps", () => {
  const snap = snapshotEnv();
  try {
    useDodoEnv();
    const secret = process.env.DODO_PAYMENTS_WEBHOOK_KEY!;
    const provider = new DodoPaymentsProvider();
    const { raw } = succeededPayload();
    const id = "wh_xyz";
    const ts = String(Math.floor(Date.now() / 1000));

    const tampered = provider.verifyWebhook(`${raw} `, signDodo(id, ts, raw, secret), { webhookId: id, webhookTimestamp: ts });
    assert.deepEqual(tampered, { ok: false, reason: "invalid_signature" });

    const noId = provider.verifyWebhook(raw, signDodo(id, ts, raw, secret), { webhookId: null, webhookTimestamp: ts });
    assert.deepEqual(noId, { ok: false, reason: "missing_webhook_id" });

    const oldTs = String(Math.floor(Date.now() / 1000) - 3600);
    const stale = provider.verifyWebhook(raw, signDodo(id, oldTs, raw, secret), { webhookId: id, webhookTimestamp: oldTs });
    assert.deepEqual(stale, { ok: false, reason: "stale_timestamp" });

    delete process.env.DODO_PAYMENTS_WEBHOOK_KEY;
    const missing = new DodoPaymentsProvider().verifyWebhook(raw, "v1,x", { webhookId: id, webhookTimestamp: ts });
    assert.deepEqual(missing, { ok: false, reason: "webhook_secret_missing" });
  } finally {
    restoreEnv(snap);
  }
});

test("dodo webhook maps payment.failed to failed (observability-only)", () => {
  const snap = snapshotEnv();
  try {
    useDodoEnv();
    const secret = process.env.DODO_PAYMENTS_WEBHOOK_KEY!;
    const provider = new DodoPaymentsProvider();
    const raw = JSON.stringify({
      business_id: "biz_test",
      type: "payment.failed",
      timestamp: new Date().toISOString(),
      data: { payload_type: "Payment", payment_id: "pay_test_002", metadata: {} },
    });
    const id = "wh_fail1";
    const ts = String(Math.floor(Date.now() / 1000));
    const res = provider.verifyWebhook(raw, signDodo(id, ts, raw, secret), { webhookId: id, webhookTimestamp: ts });
    assert.ok(res.ok);
    if (res.ok) assert.equal(res.event.status, "failed");
  } finally {
    restoreEnv(snap);
  }
});

test("dodo checkout posts dynamic PWYW amount + quote metadata, refund posts payment_id", async () => {
  const snap = snapshotEnv();
  const realFetch = globalThis.fetch;
  try {
    useDodoEnv();
    const seen: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
    globalThis.fetch = (async (url: unknown, init?: { body?: unknown; headers?: Record<string, string> }) => {
      const u = String(url);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      seen.push({ url: u, body, headers: (init?.headers ?? {}) as Record<string, string> });
      if (u.endsWith("/checkouts")) {
        return { ok: true, status: 200, json: async () => ({ session_id: "cks_test_1", checkout_url: "https://checkout.test/s/1" }), text: async () => "" } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ refund_id: "rf_1", status: "succeeded" }), text: async () => "" } as unknown as Response;
    }) as typeof fetch;

    const provider = new DodoPaymentsProvider();
    const checkout = await provider.createCheckout({
      quoteId: "22222222-2222-4222-8222-222222222222",
      domain: "openai.com",
      buyerUserId: "u-alice",
      buyerHandle: "alice",
      amountCents: 94940,
      successUrl: "https://app.test/checkout/return?quote_id=22222222-2222-4222-8222-222222222222",
      cancelUrl: "https://app.test/domain/openai.com?checkout=cancelled",
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
    });
    assert.equal(checkout.checkoutUrl, "https://checkout.test/s/1");
    assert.equal(checkout.providerPaymentId, "cks_test_1");

    const cart = (seen[0].body.product_cart as Array<Record<string, unknown>>)[0];
    assert.equal(cart.product_id, "pdt_test_123");
    assert.equal(cart.amount, 94940);
    assert.deepEqual(seen[0].body.allowed_payment_method_types, ["credit", "debit"]);
    assert.equal(seen[0].body.cancel_url, "https://app.test/domain/openai.com?checkout=cancelled");
    const meta = seen[0].body.metadata as Record<string, string>;
    assert.equal(meta.quote_id, "22222222-2222-4222-8222-222222222222");
    assert.equal(meta.amount_cents, "94940");
    assert.ok(seen[0].url.startsWith("https://test.dodopayments.com/"));
    // One quote maps to one provider session: the checkout idempotency key is
    // what stops a timed-out create from minting a second payable session.
    assert.equal(seen[0].headers["Idempotency-Key"], "checkout:22222222-2222-4222-8222-222222222222");

    const refund = await provider.refundPayment({
      paymentId: "pay_test_001",
      reason: "stale_quote",
      idempotencyKey: refundIdempotencyKey("dodo", "pay_test_001"),
    });
    assert.equal(refund.ok, true);
    assert.equal(seen[1].body.payment_id, "pay_test_001");
    assert.equal(refund.indeterminate, undefined, "a definitive 200/succeeded response is not indeterminate");
  } finally {
    globalThis.fetch = realFetch;
    restoreEnv(snap);
  }
});

// Dodo documents the Standard-Webhooks request contract but NOT an
// Idempotency-Key header on POST /refunds. A timeout, abort, network failure,
// or unreadable 200 body may therefore have executed the refund, and the
// client cannot retry safely. Every such outcome must be flagged
// `indeterminate` so the ledger parks it for manual reconciliation instead of
// retrying into a double refund. HTTP error statuses are definitive (the
// provider answered), and pending/review/failed statuses are definitive too.
test("dodo refund marks unknown outcomes as indeterminate, never retryable", async () => {
  const snap = snapshotEnv();
  const realFetch = globalThis.fetch;
  try {
    useDodoEnv();
    const provider = new DodoPaymentsProvider();

    // 1. Fetch rejects (timeout/abort/network): unknown disposition.
    globalThis.fetch = (async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as unknown as typeof fetch;
    const aborted = await provider.refundPayment({ paymentId: "pay_abort", reason: "stale", idempotencyKey: "k1" });
    assert.equal(aborted.ok, false);
    assert.equal(aborted.indeterminate, true, "a timeout must be terminal-indeterminate");

    // 2. HTTP 500: the provider answered, nothing refunded -> retryable.
    globalThis.fetch = (async () => ({
      ok: false,
      status: 500,
      text: async () => "upstream error",
    })) as unknown as typeof fetch;
    const httpError = await provider.refundPayment({ paymentId: "pay_500", reason: "stale", idempotencyKey: "k2" });
    assert.equal(httpError.ok, false);
    assert.notEqual(httpError.indeterminate, true, "an HTTP error is a definitive failure");

    // 3. HTTP 200 with an unrecognized body: the refund may have been accepted.
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => "",
    })) as unknown as typeof fetch;
    const unreadable = await provider.refundPayment({ paymentId: "pay_200", reason: "stale", idempotencyKey: "k3" });
    assert.equal(unreadable.ok, false);
    assert.equal(unreadable.indeterminate, true, "an unrecognized 200 body must be indeterminate");

    // 4. Pending/review/failed statuses are provider-known dispositions.
    for (const status of ["pending", "review", "failed"]) {
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ refund_id: `rf_${status}`, status }),
        text: async () => "",
      })) as unknown as typeof fetch;
      const res = await provider.refundPayment({ paymentId: `pay_${status}`, reason: "stale", idempotencyKey: `k_${status}` });
      assert.equal(res.ok, false);
      assert.equal(res.status, status);
      assert.notEqual(res.indeterminate, true, `${status} is a recognized status`);
    }
  } finally {
    globalThis.fetch = realFetch;
    restoreEnv(snap);
  }
});

// The refund idempotency key must be a pure function of (provider, paymentId):
// no attempt token, no timestamp. If it changes between attempts, a timeout
// followed by a retry double-refunds.
test("refund idempotency keys are deterministic per payment", () => {
  assert.equal(refundIdempotencyKey("dodo", "pay_x"), "dodo:pay_x");
  assert.equal(refundIdempotencyKey("dodo", "pay_x"), refundIdempotencyKey("dodo", "pay_x"));
  assert.notEqual(refundIdempotencyKey("dodo", "pay_x"), refundIdempotencyKey("dodo", "pay_y"));
  assert.notEqual(refundIdempotencyKey("dodo", "pay_x"), refundIdempotencyKey("stripe", "pay_x"));
});

// Refund execution must pin to the event's OWNING provider. Selecting the
// env-configured provider instead would misdirect a refund after a
// Dodo<->Stripe or test<->live switch.
test("getProviderForEvent resolves the event's provider, not the configured one", () => {
  const snap = snapshotEnv();
  try {
    process.env.DODO_PAYMENTS_API_KEY = "dodo-key";
    process.env.STRIPE_SECRET_KEY = "sk_test_stripe";
    assert.equal(getProviderForEvent("dodo").name, "dodo");
    assert.equal(getProviderForEvent("stripe").name, "stripe");
    assert.equal(getProviderForEvent("demo").name, "demo");
    assert.equal(getPaymentProvider().name, "dodo", "env default still prefers Dodo");
  } finally {
    restoreEnv(snap);
  }
});

test("dodo refund does not treat pending provider work as a completed refund", async () => {
  const snap = snapshotEnv();
  const realFetch = globalThis.fetch;
  try {
    useDodoEnv();
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ refund_id: "rf_pending", status: "pending" }),
      text: async () => "",
    })) as unknown as typeof fetch;
    const result = await new DodoPaymentsProvider().refundPayment({ paymentId: "pay_pending", reason: "stale_quote", idempotencyKey: "claim-pending-1" });
    assert.equal(result.ok, false);
    assert.equal(result.status, "pending");
    assert.match(result.error ?? "", /pending/);
  } finally {
    globalThis.fetch = realFetch;
    restoreEnv(snap);
  }
});

test("dodo refund events require the original payment id", () => {
  const snap = snapshotEnv();
  try {
    useDodoEnv();
    const provider = new DodoPaymentsProvider();
    const raw = dodoPayment({ refund_id: "rf_missing_payment", status: "succeeded" }, "refund.succeeded");
    const result = verify(raw, "wh_refund_missing_payment");
    assert.deepEqual(result, { ok: false, reason: "missing_payment_id" });
    void provider;
  } finally {
    restoreEnv(snap);
  }
});

test("dodo refund events map the associated payment id", () => {
  const snap = snapshotEnv();
  try {
    useDodoEnv();
    const raw = dodoPayment({
      refund_id: "rf_success",
      payment_id: "pay_refund_source",
      amount: 590,
      currency: "USD",
      status: "succeeded",
    }, "refund.succeeded");
    const result = verify(raw, "wh_refund_success");
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.event.status, "refunded");
      assert.equal(result.event.paymentId, "pay_refund_source");
      assert.equal(result.event.amountCents, 590);
    }
  } finally {
    restoreEnv(snap);
  }
});

test("dodo webhook trusts the provider total over echoed quote metadata", () => {
  const snap = snapshotEnv();
  try {
    useDodoEnv();
    const raw = dodoPayment({
      payment_id: "pay_test_wrong_amount",
      total_amount: 500,
      tax: 0,
      currency: "USD",
      metadata: { quote_id: "33333333-3333-4333-8333-333333333333", amount_cents: "94940" },
    });
    const res = verify(raw, "wh_wrong_amount");
    assert.ok(res.ok);
    if (res.ok) assert.equal(res.event.amountCents, 500);
  } finally {
    restoreEnv(snap);
  }
});

test("dodo webhook excludes provider tax from the market amount", () => {
  const snap = snapshotEnv();
  try {
    useDodoEnv();
    const raw = dodoPayment({
      payment_id: "pay_test_taxed",
      total_amount: 590,
      tax: 90,
      currency: "USD",
      metadata: { quote_id: "44444444-4444-4444-8444-444444444444", amount_cents: "500" },
    });
    const res = verify(raw, "wh_taxed_amount");
    assert.ok(res.ok);
    if (res.ok) {
      assert.equal(res.event.amountCents, 500);
      assert.equal(res.event.taxAssumedZero, false, "a signed tax field is not an assumption");
      assert.equal(res.event.amountRejection, null);
    }
  } finally {
    restoreEnv(snap);
  }
});

// --------------------------------------------------------------- currency (1)

test("dodo webhook refuses a succeeded payment settled in another currency", () => {
  const snap = snapshotEnv();
  try {
    useDodoEnv();
    // 42000 INR minor units for a $5.00 tag. Integers alone cannot tell these
    // apart, so without the currency check this either refunds a valid payment
    // or — when the integers coincide — accepts a fraction of the value.
    const raw = dodoPayment({
      payment_id: "pay_test_inr",
      total_amount: 42000,
      tax: 0,
      currency: "INR",
      metadata: { quote_id: "55555555-5555-4555-8555-555555555555", amount_cents: "500" },
    });
    const res = verify(raw, "wh_currency_mismatch");
    assert.ok(res.ok, "signature is valid; the currency is a business rejection, not a transport failure");
    if (res.ok) {
      assert.equal(res.event.status, "succeeded");
      assert.equal(res.event.currency, "INR");
      assert.equal(res.event.amountRejection, "currency_mismatch");
      // Never null: null means "amount not asserted" downstream and SKIPS the
      // comparison. The sentinel is negative so it can never equal a quote.
      assert.equal(res.event.amountCents, UNVERIFIABLE_AMOUNT_CENTS);
      assert.ok((res.event.amountCents as number) < 0);
    }
  } finally {
    restoreEnv(snap);
  }
});

test("dodo webhook fails closed when a succeeded payment carries no currency", () => {
  const snap = snapshotEnv();
  try {
    useDodoEnv();
    const raw = dodoPayment({
      payment_id: "pay_test_no_currency",
      total_amount: 500,
      tax: 0,
      metadata: { quote_id: "66666666-6666-4666-8666-666666666666", amount_cents: "500" },
    });
    const res = verify(raw, "wh_currency_missing");
    assert.ok(res.ok);
    if (res.ok) {
      assert.equal(res.event.currency, null);
      assert.equal(res.event.amountRejection, "currency_missing");
      assert.equal(res.event.amountCents, UNVERIFIABLE_AMOUNT_CENTS);
    }
  } finally {
    restoreEnv(snap);
  }
});

test("dodo webhook honours DODO_PAYMENTS_CURRENCY and normalizes case", () => {
  const snap = snapshotEnv();
  try {
    useDodoEnv();
    process.env.DODO_PAYMENTS_CURRENCY = " eur ";
    const raw = dodoPayment({
      payment_id: "pay_test_eur",
      total_amount: 500,
      tax: 0,
      currency: "eur",
      metadata: { quote_id: "77777777-7777-4777-8777-777777777777", amount_cents: "500" },
    });
    const res = verify(raw, "wh_currency_eur");
    assert.ok(res.ok);
    if (res.ok) {
      assert.equal(res.event.currency, "EUR");
      assert.equal(res.event.amountRejection, null);
      assert.equal(res.event.amountCents, 500);
    }

    // USD is now the foreign currency.
    const usd = dodoPayment({
      payment_id: "pay_test_usd_when_eur",
      total_amount: 500,
      tax: 0,
      currency: "USD",
      metadata: { quote_id: "77777777-7777-4777-8777-777777777777", amount_cents: "500" },
    });
    const usdRes = verify(usd, "wh_currency_usd_when_eur");
    assert.ok(usdRes.ok);
    if (usdRes.ok) assert.equal(usdRes.event.amountRejection, "currency_mismatch");
  } finally {
    restoreEnv(snap);
  }
});

test("currency is not validated on non-succeeded events (no money moved)", () => {
  const snap = snapshotEnv();
  try {
    useDodoEnv();
    const raw = dodoPayment({ payment_id: "pay_test_failed_nocur", metadata: {} }, "payment.failed");
    const res = verify(raw, "wh_failed_nocur");
    assert.ok(res.ok);
    if (res.ok) {
      assert.equal(res.event.status, "failed");
      assert.equal(res.event.amountRejection, null);
    }
  } finally {
    restoreEnv(snap);
  }
});

// ------------------------------------------------------------- missing tax (2)

test("dodo webhook flags a missing tax field instead of silently guessing", () => {
  const snap = snapshotEnv();
  try {
    useDodoEnv();
    // Zero-tax jurisdiction: total IS the pre-tax market price. Treating the
    // missing tax as zero accepts it correctly.
    const untaxed = dodoPayment({
      payment_id: "pay_test_untaxed",
      total_amount: 500,
      currency: "USD",
      metadata: { quote_id: "88888888-8888-4888-8888-888888888888", amount_cents: "500" },
    });
    const res = verify(untaxed, "wh_tax_missing_untaxed");
    assert.ok(res.ok);
    if (res.ok) {
      assert.equal(res.event.amountCents, 500, "a genuinely untaxed payment must still be payable");
      assert.equal(res.event.taxAssumedZero, true, "the assumption must be visible, not silent");
    }

    // Taxed jurisdiction that omitted `tax`: the tax-inclusive total cannot
    // equal the pre-tax quote, so this can only over-reject (refund), never
    // under-collect. taxAssumedZero is what tells an operator why.
    const taxedButOmitted = dodoPayment({
      payment_id: "pay_test_tax_hidden",
      total_amount: 590,
      currency: "USD",
      metadata: { quote_id: "88888888-8888-4888-8888-888888888888", amount_cents: "500" },
    });
    const hidden = verify(taxedButOmitted, "wh_tax_missing_taxed");
    assert.ok(hidden.ok);
    if (hidden.ok) {
      assert.equal(hidden.event.amountCents, 590);
      assert.notEqual(hidden.event.amountCents, 500, "must not silently pass as the pre-tax price");
      assert.equal(hidden.event.taxAssumedZero, true);
    }
  } finally {
    restoreEnv(snap);
  }
});

test("a tax field of zero is a signed fact, not an assumption", () => {
  const snap = snapshotEnv();
  try {
    useDodoEnv();
    const raw = dodoPayment({
      payment_id: "pay_test_zero_tax",
      total_amount: 500,
      tax: 0,
      currency: "USD",
      metadata: { quote_id: "99999999-9999-4999-8999-999999999999", amount_cents: "500" },
    });
    const res = verify(raw, "wh_tax_zero");
    assert.ok(res.ok);
    if (res.ok) {
      assert.equal(res.event.amountCents, 500);
      assert.equal(res.event.taxAssumedZero, false);
    }
  } finally {
    restoreEnv(snap);
  }
});

test("a missing tax on a non-succeeded event is not flagged", () => {
  const snap = snapshotEnv();
  try {
    useDodoEnv();
    const raw = dodoPayment({ payment_id: "pay_test_cancel", total_amount: 500, currency: "USD", metadata: {} }, "payment.cancelled");
    const res = verify(raw, "wh_cancel_no_tax");
    assert.ok(res.ok);
    if (res.ok) assert.equal(res.event.taxAssumedZero, false);
  } finally {
    restoreEnv(snap);
  }
});

// ---------------------------------------------------------------- disputes (3)

test("dodo dispute events map to the disputed status with their dispute detail", () => {
  const snap = snapshotEnv();
  try {
    useDodoEnv();
    const raw = JSON.stringify({
      business_id: "biz_test",
      type: "dispute.opened",
      timestamp: new Date().toISOString(),
      data: {
        payload_type: "Dispute",
        dispute_id: "dis_test_001",
        payment_id: "pay_test_disputed",
        dispute_stage: "dispute",
        dispute_status: "dispute_opened",
        amount: 500,
        currency: "USD",
      },
    });
    const res = verify(raw, "wh_dispute_opened");
    assert.ok(res.ok);
    if (res.ok) {
      assert.equal(res.event.status, "disputed");
      assert.equal(res.event.type, "dispute.opened");
      assert.equal(res.event.paymentId, "pay_test_disputed");
      assert.deepEqual(res.event.dispute, {
        disputeId: "dis_test_001",
        stage: "dispute",
        status: "dispute_opened",
        amountCents: 500,
        currency: "USD",
      });
      // A dispute must never be mistaken for a payment outcome.
      assert.notEqual(res.event.status, "succeeded");
      assert.notEqual(res.event.status, "failed");
    }
  } finally {
    restoreEnv(snap);
  }
});

test("every dodo dispute lifecycle event maps to disputed, not failed or other", () => {
  const snap = snapshotEnv();
  try {
    useDodoEnv();
    const types = [
      "dispute.opened",
      "dispute.challenged",
      "dispute.accepted",
      "dispute.cancelled",
      "dispute.expired",
      "dispute.won",
      "dispute.lost",
    ];
    for (const type of types) {
      const raw = JSON.stringify({
        business_id: "biz_test",
        type,
        timestamp: new Date().toISOString(),
        data: { payload_type: "Dispute", dispute_id: `dis_${type}`, payment_id: "pay_lifecycle", currency: "USD" },
      });
      const res = verify(raw, `wh_${type}`);
      assert.ok(res.ok, `${type} must verify`);
      if (res.ok) {
        assert.equal(res.event.status, "disputed", `${type} must map to disputed`);
        assert.equal(res.event.dispute?.disputeId, `dis_${type}`);
        assert.equal(res.event.dispute?.status, type, "status falls back to the event type");
      }
    }
  } finally {
    restoreEnv(snap);
  }
});

test("non-dispute events carry no dispute record", () => {
  const snap = snapshotEnv();
  try {
    useDodoEnv();
    const { raw } = succeededPayload();
    const res = verify(raw, "wh_no_dispute");
    assert.ok(res.ok);
    if (res.ok) assert.equal(res.event.dispute, null);
  } finally {
    restoreEnv(snap);
  }
});

test("dispute ledger records one row per delivery and converges on retry", async () => {
  resetMemoryDisputes();
  try {
    const record = {
      provider: "dodo",
      providerEventId: "wh_dispute_ledger_1",
      providerPaymentId: "pay_test_disputed",
      providerDisputeId: "dis_test_001",
      eventType: "dispute.opened",
      stage: "dispute",
      status: "dispute_opened",
      amountCents: 500,
      currency: "USD",
    };
    assert.deepEqual(await recordPaymentDispute(record), { ok: true });
    // A provider retry of the same delivery must converge, not duplicate.
    assert.deepEqual(await recordPaymentDispute({ ...record, status: "dispute_challenged" }), { ok: true });
    const rows = listMemoryDisputes().filter((r) => r.providerEventId === "wh_dispute_ledger_1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "dispute_challenged");
    assert.equal(rows[0].providerPaymentId, "pay_test_disputed");

    // A later lifecycle event is its own row, queryable against the payment.
    await recordPaymentDispute({ ...record, providerEventId: "wh_dispute_ledger_2", eventType: "dispute.lost", status: "dispute_lost" });
    const byPayment = listMemoryDisputes().filter((r) => r.providerPaymentId === "pay_test_disputed");
    assert.equal(byPayment.length, 2);
  } finally {
    resetMemoryDisputes();
  }
});

// ------------------------------------------------------- malformed input (5)

test("malformed signatures and headers are rejected without throwing", () => {
  const snap = snapshotEnv();
  try {
    useDodoEnv();
    const { raw } = succeededPayload();
    const provider = new DodoPaymentsProvider();
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = { webhookId: "wh_malformed", webhookTimestamp: ts };
    const malformed = [
      "",
      ",",
      "v1,",
      "v1=",
      "   ",
      "v1,!!!not-base64!!!",
      "v1," + "A".repeat(10_000),
      "v1,short",
      "v0,abc v1,def",
      "  ",
      "v1,\u{1F600}",
    ];
    for (const sig of malformed) {
      const res = provider.verifyWebhook(raw, sig, headers);
      assert.equal(res.ok, false, `signature ${JSON.stringify(sig)} must not verify`);
    }

    // Non-numeric / absurd timestamps must reject, never throw.
    for (const bad of ["not-a-number", "1e400", "-1e400", "NaN"]) {
      const res = provider.verifyWebhook(raw, "v1,AAAA", { webhookId: "wh_x", webhookTimestamp: bad });
      assert.equal(res.ok, false);
    }

    // A valid signature over a non-JSON body is an invalid payload, not a crash.
    const secret = process.env.DODO_PAYMENTS_WEBHOOK_KEY!;
    const notJson = "<html>nope</html>";
    const bad = provider.verifyWebhook(notJson, signDodo("wh_nj", ts, notJson, secret), {
      webhookId: "wh_nj",
      webhookTimestamp: ts,
    });
    assert.deepEqual(bad, { ok: false, reason: "invalid_payload" });

    // Valid signature, JSON without a type.
    const noType = JSON.stringify({ data: {} });
    const typeless = provider.verifyWebhook(noType, signDodo("wh_nt", ts, noType, secret), {
      webhookId: "wh_nt",
      webhookTimestamp: ts,
    });
    assert.deepEqual(typeless, { ok: false, reason: "missing_event_type" });
  } finally {
    restoreEnv(snap);
  }
});

test("an empty expected digest never verifies (no zero-length buffer match)", () => {
  const snap = snapshotEnv();
  try {
    useDodoEnv();
    const { raw } = succeededPayload();
    const ts = String(Math.floor(Date.now() / 1000));
    // "v1=" strips to an empty candidate, which must not compare equal to
    // anything even though two empty buffers are byte-identical.
    const res = new DodoPaymentsProvider().verifyWebhook(raw, "v1=", { webhookId: "wh_empty", webhookTimestamp: ts });
    assert.deepEqual(res, { ok: false, reason: "malformed_signature" });
  } finally {
    restoreEnv(snap);
  }
});
