// The money-path alert sink.
//
// logEvent()'s structured JSON is what an operator actually alerts on, and
// until now the ONLY external forwarding was an optional Sentry import of a
// package that is not a dependency — so a production refund failure produced a
// log line nobody was watching. ALERT_WEBHOOK_URL is the dependency-free
// replacement, so these tests pin the properties that make it trustworthy:
// it fires on error-level events, stays quiet for info/warn, strips
// secret-shaped fields, and never throws or blocks the caller.
import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { logEvent, sanitizeAlertFields } from "../../src/lib/logger.ts";

type Captured = { body: string; contentType: string | undefined };

async function withServer(): Promise<{ url: string; received: Captured[]; close: () => Promise<void> }> {
  const received: Captured[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ body, contentType: req.headers["content-type"] as string | undefined });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/alerts`,
    received,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for the alert webhook");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Silence the structured log line so test output stays readable. */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

/** Run `fn` with ALERT_WEBHOOK_URL pointed at `url`, restoring it afterwards. */
async function withWebhookUrl(url: string | null, fn: () => Promise<void>): Promise<void> {
  const previous = process.env.ALERT_WEBHOOK_URL;
  if (url === null) delete process.env.ALERT_WEBHOOK_URL;
  else process.env.ALERT_WEBHOOK_URL = url;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.ALERT_WEBHOOK_URL;
    else process.env.ALERT_WEBHOOK_URL = previous;
  }
}

test("an error-level event is POSTed to ALERT_WEBHOOK_URL as JSON", async () => {
  const srv = await withServer();
  try {
    await withWebhookUrl(srv.url, async () => {
      await quiet(async () => {
        logEvent("refund_failed", "error", { provider: "dodo", payment_id: "pay_123", attempts: 3 });
        await waitFor(() => srv.received.length === 1);
      });
    });
    assert.equal(srv.received.length, 1, "exactly one delivery");
    assert.match(srv.received[0]!.contentType ?? "", /application\/json/);
    const payload = JSON.parse(srv.received[0]!.body) as Record<string, unknown>;
    assert.equal(payload.event, "refund_failed");
    assert.equal(payload.level, "error");
    assert.equal(payload.payment_id, "pay_123");
    assert.equal(payload.attempts, 3);
  } finally {
    await srv.close();
  }
});


test("info and warn events never wake the alert webhook", async () => {
  const srv = await withServer();
  try {
    await withWebhookUrl(srv.url, async () => {
      await quiet(async () => {
        logEvent("stale_payment_refunded", "info", { payment_id: "pay_ok" });
        logEvent("payment_succeeded_takeover_stale", "warn", { payment_id: "pay_stale" });
        // Give any erroneous delivery a chance to arrive before asserting none did.
        await new Promise((r) => setTimeout(r, 150));
      });
    });
    assert.equal(srv.received.length, 0, "only errors alert");
  } finally {
    await srv.close();
  }
});

test("secret- and PII-shaped fields are stripped before forwarding", async () => {
  const srv = await withServer();
  try {
    await withWebhookUrl(srv.url, async () => {
      await quiet(async () => {
        logEvent("webhook_processing_failed", "error", {
          provider: "dodo",
          webhook_secret: "whsec_supersecret",
          api_token: "tok_abc",
          user_email: "buyer@example.com",
          password: "hunter2",
          // A nested object must not slip through either.
          raw_body: { nested: "value" },
        });
        await waitFor(() => srv.received.length === 1);
      });
    });
    const payload = JSON.parse(srv.received[0]!.body) as Record<string, unknown>;
    assert.equal(payload.provider, "dodo", "safe fields survive");
    for (const key of ["webhook_secret", "api_token", "user_email", "password", "raw_body"]) {
      assert.equal(key in payload, false, `${key} must not be forwarded`);
    }
  } finally {
    await srv.close();
  }
});

test("a missing or unreachable ALERT_WEBHOOK_URL never throws from logEvent", async () => {
  await withWebhookUrl(null, async () => {
    await quiet(async () => {
      assert.doesNotThrow(() => logEvent("refund_failed", "error", { payment_id: "pay_none" }));
    });
  });
  await withWebhookUrl("http://127.0.0.1:1/does-not-exist", async () => {
    await quiet(async () => {
      assert.doesNotThrow(() => logEvent("refund_failed", "error", { payment_id: "pay_dead" }));
      // Let the doomed fetch settle so its rejection is observed, not unhandled.
      await new Promise((r) => setTimeout(r, 100));
    });
  });
});

test("sanitizeAlertFields keeps primitives and drops everything else", () => {
  const out = sanitizeAlertFields({
    ok_string: "s",
    ok_number: 1,
    ok_bool: true,
    ok_null: null,
    nested: { a: 1 },
    array: [1, 2],
    access_token: "x",
  });
  assert.deepEqual(out, { ok_string: "s", ok_number: 1, ok_bool: true, ok_null: null });
});
