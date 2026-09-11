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
  for (let i = 0; i < TELEMETRY_LOCAL_LIMIT; i++) withinLocalTelemetryBudget("view");

  const counted = await shouldCountView({
    event: "tag_viewed",
    resource: "domain:never-seen-before.com",
    ip: "198.51.100.77",
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
  while (withinLocalTelemetryBudget("view")) allowed++;
  assert.equal(allowed, before, "bot traffic must not consume the budget");
});
