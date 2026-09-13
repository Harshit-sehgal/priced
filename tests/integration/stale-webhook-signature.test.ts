// The stale-but-signed webhook waiver must never become a signature bypass.
//
// `parseStaleWebhookEvent` runs verification twice: once normally, and — only
// when the first pass reports `stale_timestamp` — again with the freshness
// window disabled. The subtlety that makes this dangerous is that the
// freshness check runs BEFORE the HMAC is computed, so a `stale_timestamp`
// result proves NOTHING about the signature. The entire security of the path
// is the second pass recomputing the full digest.
//
// A comment cannot enforce that. If someone "optimises" the second call away
// and trusts `first.reason`, every expired-timestamp delivery becomes
// forgeable — an attacker could post an arbitrary payload with an old
// timestamp and any signature. These tests fail loudly if that happens.
import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { parseStaleWebhookEvent } from "../../src/lib/payments.ts";

const SECRET = "test-stale-secret";
const OLD_TS = String(Math.floor(Date.now() / 1000) - 3600); // an hour stale

function signDodo(webhookId: string, timestamp: string, raw: string, secret: string): string {
  return createHmac("sha256", secret).update(`${webhookId}.${timestamp}.${raw}`, "utf8").digest("base64");
}

function body(paymentId = "pay_stale_1") {
  return JSON.stringify({
    type: "payment.succeeded",
    data: { payment_id: paymentId, total_amount: 500, tax: 0, currency: "USD", metadata: { quote_id: "q-stale" } },
  });
}

function withSecret<T>(run: () => T): T {
  const prev = process.env.DODO_PAYMENTS_WEBHOOK_KEY;
  process.env.DODO_PAYMENTS_WEBHOOK_KEY = SECRET;
  try {
    return run();
  } finally {
    if (prev === undefined) delete process.env.DODO_PAYMENTS_WEBHOOK_KEY;
    else process.env.DODO_PAYMENTS_WEBHOOK_KEY = prev;
  }
}

test("a stale delivery with a FORGED signature is still rejected", () => {
  withSecret(() => {
    const raw = body();
    const result = parseStaleWebhookEvent("dodo", raw, "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", {
      webhookId: "evt-forged",
      webhookTimestamp: OLD_TS,
    });
    assert.equal(result.ok, false, "an old timestamp must not waive signature verification");
    if (!result.ok) assert.equal(result.reason, "invalid_signature");
  });
});

test("a stale delivery signed with the WRONG secret is rejected", () => {
  withSecret(() => {
    const raw = body();
    const wrong = signDodo("evt-wrong", OLD_TS, raw, "attacker-secret");
    const result = parseStaleWebhookEvent("dodo", raw, `v1,${wrong}`, {
      webhookId: "evt-wrong",
      webhookTimestamp: OLD_TS,
    });
    assert.equal(result.ok, false, "a signature from another key must never verify");
  });
});

// Tampering after signing must fail even though the timestamp is stale: this
// is the case where trusting the first pass would let an attacker rewrite the
// amount on a genuinely-captured old delivery.
test("a stale delivery whose body was tampered with is rejected", () => {
  withSecret(() => {
    const original = body();
    const sig = signDodo("evt-tamper", OLD_TS, original, SECRET);
    const tampered = original.replace('"total_amount":500', '"total_amount":1');
    assert.notEqual(tampered, original, "the tamper must actually change the body");
    const result = parseStaleWebhookEvent("dodo", tampered, `v1,${sig}`, {
      webhookId: "evt-tamper",
      webhookTimestamp: OLD_TS,
    });
    assert.equal(result.ok, false, "a rewritten body must not verify");
  });
});

// The legitimate case the waiver exists for: genuinely signed, merely old.
test("a stale delivery with a VALID signature is accepted", () => {
  withSecret(() => {
    const raw = body("pay_stale_ok");
    const sig = signDodo("evt-valid", OLD_TS, raw, SECRET);
    const result = parseStaleWebhookEvent("dodo", raw, `v1,${sig}`, {
      webhookId: "evt-valid",
      webhookTimestamp: OLD_TS,
    });
    assert.equal(result.ok, true, "the waiver must still admit a genuinely signed old event");
    if (result.ok) {
      assert.equal(result.event.paymentId, "pay_stale_ok");
      // The event id is the webhook-id header, which is INSIDE the signed
      // content — so it cannot be varied to defeat payment_events dedup.
      assert.equal(result.event.id, "evt-valid");
    }
  });
});

test("a missing webhook secret never yields ok", () => {
  const prev = process.env.DODO_PAYMENTS_WEBHOOK_KEY;
  delete process.env.DODO_PAYMENTS_WEBHOOK_KEY;
  try {
    const result = parseStaleWebhookEvent("dodo", body(), "v1,whatever", {
      webhookId: "evt-nosecret",
      webhookTimestamp: OLD_TS,
    });
    assert.equal(result.ok, false);
  } finally {
    if (prev !== undefined) process.env.DODO_PAYMENTS_WEBHOOK_KEY = prev;
  }
});
