// The client IP is a rate-limit dimension, so its trust model is a security
// boundary. On Cloudflare Workers `X-Forwarded-For` is NOT sanitized, so a
// client can forge it; only platform-set headers may be trusted above it.
import assert from "node:assert/strict";
import test from "node:test";
import { clientIp } from "../../src/lib/client-ip.ts";

const h = (o: Record<string, string>) => new Headers(o);

test("platform headers win over a forged x-forwarded-for", () => {
  // The attack: a client sends its own XFF to get a fresh limiter bucket.
  assert.equal(
    clientIp(h({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "1.2.3.4" })),
    "203.0.113.7",
  );
  assert.equal(
    clientIp(h({ "x-vercel-forwarded-for": "203.0.113.8", "x-forwarded-for": "1.2.3.4" })),
    "203.0.113.8",
  );
  assert.equal(
    clientIp(h({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "1.2.3.4" })),
    "203.0.113.9",
  );
});

test("cloudflare takes precedence over every other source", () => {
  assert.equal(
    clientIp(h({
      "cf-connecting-ip": "203.0.113.1",
      "x-vercel-forwarded-for": "198.51.100.1",
      "x-real-ip": "198.51.100.2",
      "x-forwarded-for": "1.2.3.4",
    })),
    "203.0.113.1",
  );
});

test("x-forwarded-for is still honoured when it is the only source (local dev)", () => {
  assert.equal(clientIp(h({ "x-forwarded-for": "198.51.100.5" })), "198.51.100.5");
  assert.equal(clientIp(h({ "x-forwarded-for": "198.51.100.5, 10.0.0.1" })), "198.51.100.5");
});

test("an unidentifiable client shares one strict bucket, never escapes the limiter", () => {
  assert.equal(clientIp(h({})), "unknown");
  assert.equal(clientIp(h({ "x-forwarded-for": "" })), "unknown");
  assert.equal(clientIp(h({ "x-forwarded-for": "   " })), "unknown");
  assert.equal(clientIp(h({ "cf-connecting-ip": "  " })), "unknown");
});

test("a proxy chain uses the left-most entry of the trusted header", () => {
  assert.equal(clientIp(h({ "x-vercel-forwarded-for": "203.0.113.2, 70.41.3.18" })), "203.0.113.2");
});
