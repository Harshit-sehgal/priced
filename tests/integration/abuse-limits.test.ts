// Abuse limits for the unauthenticated, write-amplifying surfaces:
// /api/analytics, /api/market/pulse, and the server-rendered view events
// (profile_viewed / tag_viewed / share_visit).
//
// These paths are unauthenticated by design and each accepted request used to
// cost a ~2 KB analytics_events row or an unbounded pair of Supabase queries,
// which on a 500 MB free-tier database is a storage/cost exhaustion path. The
// guards live in src/lib/view-events.ts; the live Upstash behavior is verified
// in staging (DEPLOY.md), so CI exercises the in-memory limiter fallback.
import assert from "node:assert/strict";
import test from "node:test";

// Demo mode (also the CI default): no datastore, no Redis credentials.
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { resetRateLimitForTests } from "../../src/lib/ratelimit.ts";
import {
  isBotUserAgent,
  shouldCountView,
  sanitizeAnalyticsProps,
  MAX_ANALYTICS_PROP_KEYS,
  ANALYTICS_IP_LIMIT,
  ANALYTICS_SESSION_LIMIT,
  VIEW_IP_LIMIT,
} from "../../src/lib/view-events.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { POST: analyticsPOST } = (await import("../../src/app/api/analytics/route.ts")) as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { GET: pulseGET } = (await import("../../src/app/api/market/pulse/route.ts")) as any;

type StubResponse = { status: number; body: unknown };

const HUMAN_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

test.beforeEach(() => resetRateLimitForTests());

function analyticsRequest(body: unknown, ip: string): Request {
  return new Request("http://localhost/api/analytics", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

// ------------------------------------------------------------- bot filter
test("bot filter: real browsers count, automation and unfurlers do not", () => {
  assert.equal(isBotUserAgent(HUMAN_UA), false);
  assert.equal(
    isBotUserAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    ),
    false,
  );

  for (const ua of [
    "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
    "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
    "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
    "Twitterbot/1.0",
    "WhatsApp/2.23.20.0",
    "TelegramBot (like TwitterBot)",
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "curl/8.5.0",
    "python-requests/2.31.0",
    "Go-http-client/2.0",
    "node-fetch/1.0",
    "HeadlessChrome/120.0.0.0",
  ]) {
    assert.equal(isBotUserAgent(ua), true, `expected bot: ${ua}`);
  }

  // A missing user agent is a script, not a person.
  assert.equal(isBotUserAgent(null), true);
  assert.equal(isBotUserAgent(""), true);
  assert.equal(isBotUserAgent("   "), true);
});

// ------------------------------------------------------- view-event guard
test("view guard: one row per (IP, resource) per dedup window", async () => {
  const args = { event: "tag_viewed", resource: "domain:example.com", ip: "9.9.9.1", userAgent: HUMAN_UA } as const;
  assert.equal(await shouldCountView(args), true);
  // A curl loop, a crawler retry, or a LiveRefresh re-render must not add rows.
  assert.equal(await shouldCountView(args), false);
  assert.equal(await shouldCountView(args), false);
});

test("view guard: dedup is per resource, per IP, and per event", async () => {
  const base = { event: "tag_viewed", resource: "domain:a.com", ip: "9.9.9.2", userAgent: HUMAN_UA } as const;
  assert.equal(await shouldCountView(base), true);
  assert.equal(await shouldCountView({ ...base, resource: "domain:b.com" }), true);
  assert.equal(await shouldCountView({ ...base, ip: "9.9.9.3" }), true);
  assert.equal(await shouldCountView({ ...base, event: "profile_viewed" }), true);
  // ...and the original pair is still deduped.
  assert.equal(await shouldCountView(base), false);
});

test("view guard: bots never persist a row, even on a fresh resource", async () => {
  assert.equal(
    await shouldCountView({
      event: "share_visit",
      resource: "sale:abc",
      ip: "9.9.9.4",
      userAgent: "Slackbot-LinkExpanding 1.0",
    }),
    false,
  );
  // A human on the same never-counted resource still counts: the bot request
  // must not consume the dedup slot.
  assert.equal(
    await shouldCountView({ event: "share_visit", resource: "sale:abc", ip: "9.9.9.4", userAgent: HUMAN_UA }),
    true,
  );
});

test("view guard: per-IP budget caps a scraper walking distinct resources", async () => {
  const ip = "9.9.9.5";
  for (let i = 0; i < VIEW_IP_LIMIT; i++) {
    assert.equal(
      await shouldCountView({ event: "tag_viewed", resource: `domain:d${i}.com`, ip, userAgent: HUMAN_UA }),
      true,
      `resource ${i} should count`,
    );
  }
  assert.equal(
    await shouldCountView({ event: "tag_viewed", resource: "domain:over.com", ip, userAgent: HUMAN_UA }),
    false,
  );
  // The budget is per IP, so an unrelated visitor is unaffected.
  assert.equal(
    await shouldCountView({ event: "tag_viewed", resource: "domain:over.com", ip: "9.9.9.6", userAgent: HUMAN_UA }),
    true,
  );
});

test("view guard: handles are lowercased so case variants share one slot", async () => {
  const ip = "9.9.9.7";
  assert.equal(await shouldCountView({ event: "profile_viewed", resource: "u:Harshit", ip, userAgent: HUMAN_UA }), true);
  assert.equal(await shouldCountView({ event: "profile_viewed", resource: "u:harshit", ip, userAgent: HUMAN_UA }), false);
});

// ------------------------------------------------------------- props cap
test("props cap: at most MAX_ANALYTICS_PROP_KEYS keys are persisted", () => {
  const props: Record<string, unknown> = {};
  for (let i = 0; i < 206; i++) props[`k${i}`] = "v";
  const { props: safe, droppedKeys } = sanitizeAnalyticsProps(props);
  assert.equal(Object.keys(safe).length, MAX_ANALYTICS_PROP_KEYS);
  assert.equal(droppedKeys, 206 - MAX_ANALYTICS_PROP_KEYS);
});

test("props cap: still drops secrets/PII, non-scalars, and long values", () => {
  const { props: safe } = sanitizeAnalyticsProps({
    domain: "example.com",
    access_token: "sk-should-not-persist",
    user_password: "hunter2",
    email: "a@b.co",
    client_secret: "nope",
    nested: { dropped: true },
    list: [1, 2, 3],
    keep_me: "yes",
    count: 7,
    flag: false,
    nothing: null,
    long: "x".repeat(4_000),
  });
  assert.deepEqual(Object.keys(safe).sort(), ["count", "domain", "flag", "keep_me", "long", "nothing"]);
  assert.equal((safe.long as string).length, 512);
  assert.equal(safe.nothing, null);
  assert.equal(safe.flag, false);
});

test("props cap: a full 10 KiB body cannot smuggle kilobytes of jsonb", () => {
  // 206 keys is what previously fit inside the route's 10 KiB body limit.
  const props: Record<string, unknown> = {};
  for (let i = 0; i < 206; i++) props[`key_${i}`] = "y".repeat(20);
  const { props: safe } = sanitizeAnalyticsProps(props);
  const persistedBytes = JSON.stringify(safe).length;
  assert.ok(persistedBytes < 1_024, `persisted jsonb should stay under 1 KiB, got ${persistedBytes}`);
});

// --------------------------------------------------------- /api/analytics
test("analytics: accepts up to the per-IP limit, then sheds without failing the caller", async () => {
  const ip = "10.0.0.1";
  for (let i = 0; i < ANALYTICS_IP_LIMIT; i++) {
    const res = (await analyticsPOST(analyticsRequest({ event: "homepage_viewed" }, ip))) as StubResponse;
    assert.equal(res.status, 200, `request ${i} should be accepted`);
  }
  const limited = (await analyticsPOST(analyticsRequest({ event: "homepage_viewed" }, ip))) as StubResponse;
  assert.equal(limited.status, 429);
  // Never throws and never reports failure to the funnel: callers swallow
  // errors, so the body stays ok:true while the drop reason is explicit.
  assert.deepEqual(limited.body, { ok: true, dropped: "rate_limited" });

  // The limit is per IP — a different visitor is unaffected.
  const other = (await analyticsPOST(analyticsRequest({ event: "homepage_viewed" }, "10.0.0.2"))) as StubResponse;
  assert.equal(other.status, 200);
});

test("analytics: the session dimension limits one tab below the IP budget", async () => {
  const ip = "10.0.0.3";
  const session = "session-abc";
  for (let i = 0; i < ANALYTICS_SESSION_LIMIT; i++) {
    const res = (await analyticsPOST(
      analyticsRequest({ event: "domain_searched", session_id: session }, ip),
    )) as StubResponse;
    assert.equal(res.status, 200, `request ${i} should be accepted`);
  }
  const limited = (await analyticsPOST(
    analyticsRequest({ event: "domain_searched", session_id: session }, ip),
  )) as StubResponse;
  assert.equal(limited.status, 429);
  assert.deepEqual(limited.body, { ok: true, dropped: "rate_limited" });

  // Same IP, different tab: still under the IP budget, so it is accepted.
  const otherTab = (await analyticsPOST(
    analyticsRequest({ event: "domain_searched", session_id: "session-xyz" }, ip),
  )) as StubResponse;
  assert.equal(otherTab.status, 200);
});

test("analytics: rate limiting does not weaken the existing validation", async () => {
  const nonJson = new Request("http://localhost/api/analytics", {
    method: "POST",
    headers: { "content-type": "text/plain", "x-forwarded-for": "10.0.0.4" },
    body: "event=homepage_viewed",
  });
  assert.equal(((await analyticsPOST(nonJson)) as StubResponse).status, 415);
  assert.equal(((await analyticsPOST(analyticsRequest({ event: "nope" }, "10.0.0.4"))) as StubResponse).status, 422);
  assert.equal(
    ((await analyticsPOST(
      analyticsRequest({ event: "homepage_viewed", pad: "x".repeat(11_000) }, "10.0.0.4"),
    )) as StubResponse).status,
    413,
  );
});

// ------------------------------------------------------ /api/market/pulse
function pulseRequest(ip: string): Request {
  return new Request("http://localhost/api/market/pulse", { headers: { "x-forwarded-for": ip } });
}

test("pulse: demo polling works and is capped per IP", async () => {
  const ip = "10.1.0.1";
  const first = (await pulseGET(pulseRequest(ip))) as Response;
  assert.equal(first.status, 200);
  assert.ok(typeof ((await first.json()) as { v?: string }).v === "string");

  // One polling tab costs 12 requests/minute; the ceiling leaves room for
  // several tabs behind one NAT and still bounds a scripted flood.
  let limitedAt = -1;
  for (let i = 1; i <= 200; i++) {
    const res = (await pulseGET(pulseRequest(ip))) as Response;
    if (res.status === 429) {
      limitedAt = i;
      break;
    }
  }
  assert.ok(limitedAt > 0 && limitedAt <= 100, `pulse should rate limit, limited at ${limitedAt}`);

  const other = (await pulseGET(pulseRequest("10.1.0.2"))) as Response;
  assert.equal(other.status, 200);
});

test("pulse: responses are cacheable instead of no-store", async () => {
  const res = (await pulseGET(pulseRequest("10.1.0.3"))) as Response;
  const cc = res.headers.get("cache-control") ?? "";
  assert.ok(cc.includes("s-maxage"), `expected a shared cache window, got "${cc}"`);
  assert.ok(!cc.includes("no-store"), `expected the 200 not to be no-store, got "${cc}"`);
});

test("pulse: a configured deployment still answers a real fingerprint for clients that poll", async () => {
  const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const previousKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  try {
    // The client picks Realtime-vs-polling from NEXT_PUBLIC_* inlined at BUILD
    // time while this route reads the server's RUNTIME env. When a build has no
    // inlined public env (Cloudflare Workers/OpenNext is exactly this shape),
    // the client polls a server that used to answer the constant "realtime":
    // the poller's lastVersion then never changes and live updates silently
    // stop. A polling client must always get a real composite fingerprint.
    delete (globalThis as { __pricedPulse?: unknown }).__pricedPulse;
    const res = (await pulseGET(pulseRequest("10.1.0.1"))) as Response;
    assert.equal(res.status, 200);
    const body = (await res.json()) as { v?: string };
    assert.notEqual(body.v, "realtime", "the frozen constant must never be returned");
    assert.match(body.v ?? "", /\|/, "expected the composite fingerprint format");
  } finally {
    if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = previousKey;
  }
});
