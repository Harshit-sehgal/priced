// Batched rate limiting (rateLimitAll).
//
// The money-path routes layer 2-4 dimensions. Awaiting them separately cost a
// full round-trip each and burned a command per dimension against the
// free-tier Upstash database that checkout depends on — and `rateLimit` fails
// CLOSED, so exhausting that quota 429s the money path.
//
// The invariants pinned here: batching must not change the verdict, must not
// change WHICH counters advance, and must deny on anything it cannot fully
// account for. "Unsure" resolving to "allowed" on a money path is the failure
// mode that matters.
import assert from "node:assert/strict";
import test from "node:test";
import { rateLimitAll, rateLimit, resetRateLimitForTests } from "../../src/lib/ratelimit.ts";

test.beforeEach(() => resetRateLimitForTests());

/** Swap in a fake Upstash and restore everything afterwards. */
async function withFakeUpstash(
  handler: (calls: Array<{ input: unknown; body: unknown }>) => Promise<Response>,
  run: (calls: Array<{ input: unknown; body: unknown }>) => Promise<void>,
) {
  const prevUrl = process.env.UPSTASH_REDIS_REST_URL;
  const prevToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const prevFetch = globalThis.fetch;
  const calls: Array<{ input: unknown; body: unknown }> = [];
  process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
  process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
  globalThis.fetch = (async (input, init) => {
    calls.push({ input, body: JSON.parse(String(init?.body)) as unknown });
    return handler(calls);
  }) as typeof globalThis.fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = prevUrl;
    if (prevToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = prevToken;
  }
}

// ---------------------------------------------------------------- semantics

test("allows up to each dimension's limit, then denies", async () => {
  const dims = [
    { key: "b-user", limit: 2, windowMs: 60_000 },
    { key: "b-ip", limit: 5, windowMs: 60_000 },
  ];
  assert.equal(await rateLimitAll(dims), true);
  assert.equal(await rateLimitAll(dims), true);
  assert.equal(await rateLimitAll(dims), false, "the tighter dimension must bind");
});

test("dimensions stay isolated — one user's cap does not deny another", async () => {
  const a = [{ key: "b-user:a", limit: 1, windowMs: 60_000 }];
  assert.equal(await rateLimitAll(a), true);
  assert.equal(await rateLimitAll(a), false);
  assert.equal(await rateLimitAll([{ key: "b-user:b", limit: 1, windowMs: 60_000 }]), true);
});

// The load-bearing equivalence: batching must advance exactly the counters the
// sequential code advanced. If it short-circuited, a denied request would stop
// incrementing the later dimensions and the limiter would drift from the
// behaviour it replaced.
test("every dimension is counted even when an earlier one already denies", async () => {
  const tight = { key: "b-tight", limit: 1, windowMs: 60_000 };
  const loose = { key: "b-loose", limit: 10, windowMs: 60_000 };
  assert.equal(await rateLimitAll([tight, loose]), true);
  assert.equal(await rateLimitAll([tight, loose]), false, "tight dimension binds");
  // `loose` must have been incremented twice by the calls above, so only 8
  // remain before it denies on its own.
  for (let i = 0; i < 8; i++) {
    assert.equal(await rateLimit("b-loose", 10, 60_000), true, `loose call ${i + 3}`);
  }
  assert.equal(await rateLimit("b-loose", 10, 60_000), false, "loose must have been counted");
});

test("window expiry resets a batched counter", async () => {
  const dims = [{ key: "b-window", limit: 1, windowMs: 20 }];
  assert.equal(await rateLimitAll(dims), true);
  assert.equal(await rateLimitAll(dims), false);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(await rateLimitAll(dims), true);
});

test("an empty dimension list allows", async () => {
  assert.equal(await rateLimitAll([]), true);
});

// ------------------------------------------------------------- upstash path

test("one pipeline round-trip carries every dimension", async () => {
  await withFakeUpstash(
    async () => new Response(JSON.stringify([{ result: 1 }, { result: 1 }]), { status: 200 }),
    async (calls) => {
      const ok = await rateLimitAll([
        { key: "p-user", limit: 5, windowMs: 60_000 },
        { key: "p-ip", limit: 9, windowMs: 60_000 },
      ]);
      assert.equal(ok, true);
      assert.equal(calls.length, 1, "two dimensions must cost ONE round-trip");
      assert.equal(calls[0]?.input, "https://example.upstash.io/pipeline");
      const body = calls[0]?.body as unknown[][];
      assert.equal(body.length, 2);
      assert.equal(body[0]?.[0], "EVAL");
      assert.match(String(body[0]?.[1]), /redis\.call\('INCR'/);
      assert.equal(body[0]?.[3], "ipt:rl:p-user", "keys stay namespaced");
      assert.equal(body[1]?.[3], "ipt:rl:p-ip");
    },
  );
});

test("per-dimension limits are applied to their own counts", async () => {
  await withFakeUpstash(
    // user is at 3 (limit 5, fine); ip is at 10 (limit 9, over).
    async () => new Response(JSON.stringify([{ result: 3 }, { result: 10 }]), { status: 200 }),
    async () => {
      const ok = await rateLimitAll([
        { key: "p-user", limit: 5, windowMs: 60_000 },
        { key: "p-ip", limit: 9, windowMs: 60_000 },
      ]);
      assert.equal(ok, false, "the over-limit dimension must deny");
    },
  );
});

// ----------------------------------------------------------- fail closed

test("fails CLOSED on every unusable Upstash response", async () => {
  const dims = [
    { key: "f-user", limit: 100, windowMs: 60_000 },
    { key: "f-ip", limit: 100, windowMs: 60_000 },
  ];
  const unusable: Array<[string, () => Response]> = [
    ["HTTP 500", () => new Response("nope", { status: 500 })],
    ["HTTP 429 from Upstash itself", () => new Response("quota", { status: 429 })],
    ["non-array body", () => new Response(JSON.stringify({ result: 1 }), { status: 200 })],
    ["short array", () => new Response(JSON.stringify([{ result: 1 }]), { status: 200 })],
    ["entry carrying an error", () =>
      new Response(JSON.stringify([{ result: 1 }, { error: "ERR script" }]), { status: 200 })],
    ["non-numeric result", () =>
      new Response(JSON.stringify([{ result: 1 }, { result: "banana" }]), { status: 200 })],
    ["invalid JSON", () => new Response("<html>502</html>", { status: 200 })],
  ];
  for (const [label, make] of unusable) {
    await withFakeUpstash(
      async () => make(),
      async () => {
        assert.equal(await rateLimitAll(dims), false, `must deny on: ${label}`);
      },
    );
  }
});

test("fails CLOSED when Redis is unreachable", async () => {
  await withFakeUpstash(
    async () => {
      throw new Error("ECONNREFUSED");
    },
    async () => {
      assert.equal(
        await rateLimitAll([{ key: "f-down", limit: 100, windowMs: 60_000 }]),
        false,
        "an outage must never mean unlimited",
      );
    },
  );
});
