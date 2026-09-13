// Unit tests for /api/health and /api/analytics route handlers (demo mode —
// no datastore, which is also the CI default). Runs the real route code with
// a stubbed NextResponse via tests/helpers/register-routes.mjs; DB-backed
// behaviors are exercised on the real deployment (DEPLOY.md alert wiring).
import assert from "node:assert/strict";
import test from "node:test";

// Demo mode: no Supabase env — pulse route must not carry prod credentials.
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

// -- route imports (after env cleanup; loader hooks map "@/") ---------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { GET: healthGET } = (await import("../../src/app/api/health/route.ts")) as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { POST: analyticsPOST } = (await import("../../src/app/api/analytics/route.ts")) as any;

type StubResponse = { status: number; body: unknown; headers: Record<string, string> };

/**
 * Health returns real Response.json() objects; analytics returns the
 * NextResponse stub ({ status, body }). Handle both shapes.
 */
async function readBody(res: unknown): Promise<unknown> {
  const r = res as { body?: unknown; json?: () => Promise<unknown>; __nextResponse?: boolean };
  if (r.__nextResponse === true) return r.body;
  if (typeof r.json === "function") return await r.json();
  return r.body;
}

function jsonRequest(body: unknown, extra: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/x", {
    method: "POST",
    headers: { "content-type": "application/json", ...extra },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// ------------------------------------------------------------- /api/health
test("health: liveness probe returns ok with no DB touch by default", async () => {
  const res = (await healthGET(new Request("http://localhost/api/health"))) as unknown as Response & StubResponse;
  assert.equal(res.status, 200);
  const body = (await readBody(res)) as Record<string, unknown>;
  assert.equal(body.ok, true);
  assert.ok(typeof body.ts === "string");
  // no-store so probes never sit behind a cache
  assert.ok(String(res.headers.get?.("cache-control") ?? (res.headers as Record<string, string>)["cache-control"]).includes("no-store"));
});

test("health: ?check=db in demo mode reports the demo datastore, still ok", async () => {
  const res = (await healthGET(new Request("http://localhost/api/health?check=db"))) as unknown as Response & StubResponse;
  assert.equal(res.status, 200);
  const body = (await readBody(res)) as Record<string, unknown>;
  assert.equal(body.datastore, "demo");
  assert.equal(body.ok, true);
});

// Deep checks touch shared free-tier resources and this route is unauthenticated
// and proxy-exempt. Caching makes request volume unable to multiply upstream
// calls: two rapid probes must return the identical cached body (same ts).
test("health: deep checks are cached against anonymous loops", async () => {
  const first = (await readBody(await healthGET(new Request("http://localhost/api/health?check=db")))) as Record<string, unknown>;
  await new Promise((r) => setTimeout(r, 25));
  const second = (await readBody(await healthGET(new Request("http://localhost/api/health?check=db")))) as Record<string, unknown>;
  assert.equal(second.ts, first.ts, "the second deep probe must reuse the cached result");
});

// The cache must be keyed per check type: a cross-key leak would serve the db
// body to a redis probe (or vice versa), hiding a real dependency outage.
test("health: cache entries do not cross check types", async () => {
  const db = (await readBody(await healthGET(new Request("http://localhost/api/health?check=db")))) as Record<string, unknown>;
  const redis = (await readBody(await healthGET(new Request("http://localhost/api/health?check=redis")))) as Record<string, unknown>;
  assert.ok("datastore" in db, "db probe reports the datastore");
  assert.ok(!("redis" in db), "db probe must not carry the redis verdict");
  assert.ok("redis" in redis, "redis probe reports the redis verdict");
  assert.ok(!("datastore" in redis), "redis probe must not carry the datastore verdict");
});

// ---------------------------------------------------------- /api/analytics
test("analytics: accepts a valid event", async () => {
  const res = (await analyticsPOST(jsonRequest({ event: "homepage_viewed", props: { ref: "x" } }))) as StubResponse;
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
});

test("analytics: rejects non-JSON bodies with 415", async () => {
  const req = new Request("http://localhost/api/analytics", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "event=homepage_viewed",
  });
  const res = (await analyticsPOST(req)) as StubResponse;
  assert.equal(res.status, 415);
});

test("analytics: rejects empty and oversized bodies", async () => {
  const empty = (await analyticsPOST(jsonRequest(""))) as StubResponse;
  assert.equal(empty.status, 400);
  const big = (await analyticsPOST(jsonRequest({ event: "homepage_viewed", padding: "x".repeat(11_000) }))) as StubResponse;
  assert.equal(big.status, 413);
});

test("analytics: rejects unknown events with 422", async () => {
  const res = (await analyticsPOST(jsonRequest({ event: "not_in_taxonomy" }))) as StubResponse;
  assert.equal(res.status, 422);
});

test("analytics: sanitizes PII/secret-like props but keeps safe ones", async () => {
  // In demo mode persistAnalyticsEvent is a no-op, so this exercises the
  // validation/sanitization path; the body is dropped before any persist.
  const res = (await analyticsPOST(
    jsonRequest({
      event: "domain_opened",
      props: {
        domain: "example.com",
        access_token: "sk-should-not-persist",
        user_password: "hunter2",
        email: "a@b.co",
        keep_me: "yes",
        nested: { dropped: true },
      },
    }),
  )) as StubResponse;
  assert.equal(res.status, 200);
});

test("analytics: non-object props and exotic session ids never 500", async () => {
  const res = (await analyticsPOST(
    jsonRequest({ event: "share_visit", props: ["array", "props"], session_id: 42 }),
  )) as StubResponse;
  assert.equal(res.status, 200);
});

test("analytics: invalid JSON never 500s", async () => {
  const res = (await analyticsPOST(jsonRequest("{oops"))) as StubResponse;
  assert.equal(res.status, 400);
});
