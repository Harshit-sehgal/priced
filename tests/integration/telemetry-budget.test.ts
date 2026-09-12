// Anonymous telemetry must never be able to take down checkout.
//
// The view and analytics guards spend Upstash commands on unauthenticated
// traffic, and they share ONE free-tier Redis with the quote / checkout /
// handle limiters — which fail CLOSED. So if a flood exhausts the shared
// command quota, `rateLimit` starts returning false for everything and the
// money path 429s. Even a REJECTED request costs a command, so the Redis
// limiter alone cannot bound the spend.
//
// The in-process budget therefore has to run before any network call. These
// tests pin that ordering, which is the whole point of the guard.
import assert from "node:assert/strict";
import test from "node:test";
import {
  withinLocalTelemetryBudget,
  resetTelemetryBudgetForTests,
  shouldCountView,
  TELEMETRY_LOCAL_LIMIT,
  TELEMETRY_GLOBAL_LIMIT,
} from "../../src/lib/view-events.ts";

test.beforeEach(() => resetTelemetryBudgetForTests());

test("the local budget allows exactly the cap, then sheds", () => {
  for (let i = 0; i < TELEMETRY_LOCAL_LIMIT; i++) {
    assert.equal(withinLocalTelemetryBudget("analytics"), true, `request ${i + 1} should pass`);
  }
  assert.equal(withinLocalTelemetryBudget("analytics"), false, "the cap must hold");
  assert.equal(withinLocalTelemetryBudget("analytics"), false, "and keep holding");
});

test("dimensions are independent so views cannot starve analytics", () => {
  for (let i = 0; i < TELEMETRY_LOCAL_LIMIT; i++) withinLocalTelemetryBudget("view");
  assert.equal(withinLocalTelemetryBudget("view"), false);
  assert.equal(withinLocalTelemetryBudget("analytics"), true, "a separate dimension is unaffected");
});

// The load-bearing property: once the budget is gone, a view is refused
// WITHOUT consulting the shared limiter — even for an IP and resource that
// have never been seen, which would otherwise sail through dedup.
test("an exhausted budget short-circuits before the shared limiter is touched", async () => {
  // Exhaust the budget for THIS client — the tiers are per-client now, so a
  // different IP's budget is deliberately unaffected (covered below).
  const ip = "198.51.100.77";
  for (let i = 0; i < TELEMETRY_LOCAL_LIMIT; i++) withinLocalTelemetryBudget("view", ip);

  const counted = await shouldCountView({
    event: "tag_viewed",
    resource: "domain:never-seen-before.com",
    ip,
    userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  });
  assert.equal(counted, false, "must shed locally rather than spend a Redis command");
});

test("a fresh budget still counts a genuine view", async () => {
  const counted = await shouldCountView({
    event: "tag_viewed",
    resource: "domain:fresh-budget.com",
    ip: "198.51.100.78",
    userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  });
  assert.equal(counted, true, "the guard must not break normal counting");
});

test("bots are rejected before they can even consume local budget", async () => {
  const before = TELEMETRY_LOCAL_LIMIT;
  for (let i = 0; i < 50; i++) {
    await shouldCountView({
      event: "profile_viewed",
      resource: `u:bot-${i}`,
      ip: "198.51.100.79",
      userAgent: "Googlebot/2.1 (+http://www.google.com/bot.html)",
    });
  }
  // All 50 were bots, so the budget is untouched and still fully available.
  let allowed = 0;
  while (withinLocalTelemetryBudget("view", "198.51.100.79")) allowed++;
  assert.equal(allowed, before, "bot traffic must not consume the budget");
});

// A purely global budget bounded our Redis spend but handed an attacker a
// cheap way to blind analytics for everyone: one client could burn the whole
// allowance and suppress every other visitor's telemetry until the window
// rolled. The per-client tier exists to stop exactly that.
test("one client exhausting its budget does not suppress other clients", () => {
  const attacker = "203.0.113.99";
  for (let i = 0; i < TELEMETRY_LOCAL_LIMIT; i++) {
    assert.equal(withinLocalTelemetryBudget("analytics", attacker), true, `attacker ${i + 1}`);
  }
  assert.equal(withinLocalTelemetryBudget("analytics", attacker), false, "attacker is capped");
  // A different visitor is entirely unaffected.
  assert.equal(withinLocalTelemetryBudget("analytics", "198.51.100.4"), true);
  assert.equal(withinLocalTelemetryBudget("analytics", "198.51.100.5"), true);
});

// The per-client cap alone multiplies by the number of distinct clients, so it
// stops bounding anything. The global tier keeps the instance-wide ceiling
// that protects the shared Redis quota.
test("many distinct clients still hit the instance-wide ceiling", () => {
  let allowed = 0;
  for (let i = 0; i < TELEMETRY_GLOBAL_LIMIT + 50; i++) {
    if (withinLocalTelemetryBudget("view", `10.0.${Math.floor(i / 250)}.${i % 250}`)) allowed++;
  }
  assert.equal(allowed, TELEMETRY_GLOBAL_LIMIT, "the global tier must still bind");
});

test("an over-budget client does not consume the global allowance", () => {
  const noisy = "203.0.113.50";
  for (let i = 0; i < TELEMETRY_LOCAL_LIMIT + 500; i++) withinLocalTelemetryBudget("view", noisy);
  // The noisy client spent at most its own cap globally, so the remaining
  // global room is GLOBAL - LOCAL, not GLOBAL - (LOCAL + 500).
  let others = 0;
  for (let i = 0; i < TELEMETRY_GLOBAL_LIMIT; i++) {
    if (withinLocalTelemetryBudget("view", `10.1.${Math.floor(i / 250)}.${i % 250}`)) others++;
  }
  assert.equal(others, TELEMETRY_GLOBAL_LIMIT - TELEMETRY_LOCAL_LIMIT);
});
