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
  // x-real-ip is NOT trusted even when present: it is client-sendable on any
  // path where the edge does not overwrite it, so it must never outrank the
  // dev-only x-forwarded-for fallback — both are untrusted, and the first
  // untrusted value seen wins the "unknown vs fallback" decision below.
  assert.equal(
    clientIp(h({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "1.2.3.4" })),
    "1.2.3.4",
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

test("garbage header values collapse to the shared unknown bucket", () => {
  assert.equal(clientIp(h({ "cf-connecting-ip": "not-an-ip" })), "unknown");
  assert.equal(clientIp(h({ "x-forwarded-for": "evil-bucket-1" })), "unknown");
  assert.equal(clientIp(h({ "x-forwarded-for": "1.2.3.4, evil" })), "1.2.3.4");
  assert.equal(clientIp(h({ "cf-connecting-ip": "2001:db8::1" })), "2001:db8::1");
});

// A colon-containing string is not automatically an IPv6 address. The old
// charset check accepted these as literal IPs, which would have let a client
// rotate limiter buckets with arbitrary colon strings on any path where a
// forwarded header is the source.
test("colon-garbage is rejected, real IPv6 forms are accepted", () => {
  for (const bad of ["1:2:3", "abc:def", "1.2.3.4:", ":::", "2001:db8::1::1", "gggg::1", ":"]) {
    assert.equal(clientIp(h({ "cf-connecting-ip": bad })), "unknown", `${bad} must not be a bucket`);
  }
  for (const good of [
    "2001:db8::1",
    "::1",
    "::",
    "fe80::1",
    "2606:4700:4700::1111",
    "2001:0db8:85a3:0000:0000:8a2e:0370:7334",
    "::ffff:192.0.2.1",
    "fe80::1%eth0",
  ]) {
    assert.equal(clientIp(h({ "cf-connecting-ip": good })), good, `${good} is a literal IP`);
  }
});
