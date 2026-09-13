// The pulse endpoint once short-circuited with the constant "realtime" when the
// SERVER saw Supabase env. The client decides Realtime-vs-polling from the same
// vars INLINED AT BUILD TIME, so on Cloudflare a build without them polls a
// server that returns the constant — the poller's version never changes and
// live updates silently stop. This file sets that env BEFORE importing the
// route (Node isolates each test file in its own process), so reintroducing an
// env-gated short-circuit fails here.
import assert from "node:assert/strict";
import test from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://pulse-config.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-pulse-config";
delete process.env.SUPABASE_SERVICE_ROLE_KEY; // keep the in-memory adapter

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { GET: pulseGET } = (await import("../../src/app/api/market/pulse/route.ts")) as any;

test("pulse returns a real fingerprint even when the public Supabase env is set", async () => {
  (globalThis as { __pricedPulse?: unknown }).__pricedPulse = undefined;
  const res = (await pulseGET(
    new Request("http://localhost/api/market/pulse", { headers: { "x-forwarded-for": "10.7.7.7" } }),
  )) as Response;
  assert.equal(res.status, 200);
  const body = (await res.json()) as { v?: string };
  assert.notEqual(body.v, "realtime", "a configured server must never freeze polling clients");
  assert.match(body.v ?? "", /\|/, "expected the composite fingerprint");
});
