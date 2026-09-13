// The middleware matcher is a security-relevant regex.
//
// Every MATCHED request pays a supabase.auth.getUser() round-trip, so routes
// are excluded for cost. The danger is excluding one that genuinely needs a
// session: middleware is what refreshes the Supabase cookie, so a wrongly
// excluded route silently sees a stale or absent user.
//
// This nearly happened: `api/health` was added unanchored, which is a PREFIX,
// so a future `/api/health/deep` would have been excluded too. These tests pin
// both directions — what must skip, and what must keep its session.
import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../../src/proxy.ts";

const pattern = config.matcher[0];
const matcher = new RegExp(`^${pattern}$`);

test("matcher excludes exactly the routes that can never act on a session", () => {
  for (const path of [
    "/_next/static/chunk.js",
    "/_next/image",
    "/favicon.ico",
    "/api/webhooks/payments", // signed webhook: no user session
    "/api/market/pulse", // anonymous demo polling
    "/api/demo/sign", // demo-only, disabled in prod
    "/api/health", // hit every 15 min by the uptime workflow
    "/sitemap.xml",
    "/robots.txt",
    "/domain/openai.com/opengraph-image",
    "/success/6f1e/opengraph-image",
  ]) {
    assert.equal(matcher.test(path), false, `${path} should skip middleware`);
  }
});

test("matcher keeps every session-bearing route", () => {
  for (const path of [
    "/",
    "/login",
    "/welcome",
    "/u/harshit",
    "/u/harshit/analytics", // owner-only page — MUST see the session
    "/domain/openai.com",
    "/takeover/q-1",
    "/success/s-1",
    "/checkout/return",
    "/auth/callback",
    "/api/quotes",
    "/api/checkout",
    "/api/handle",
    "/api/profile",
    "/api/analytics",
    "/api/auth/signout",
  ]) {
    assert.equal(matcher.test(path), true, `${path} must stay session-aware`);
  }
});

// Regression: unanchored exclusions are prefixes and swallow sibling routes.
test("exact-match exclusions are anchored, not prefixes", () => {
  for (const path of [
    "/api/healthcheck",
    "/api/health/deep",
    "/sitemapaxml",
    "/robotsatxt",
    // Subtree exclusions keep their trailing slash for the same reason.
    "/api/webhooksadmin",
    "/api/demolition",
    "/api/market/pulsecheck",
    // A domain whose slug merely contains the OG segment is still a real page.
    "/domain/opengraph-image.com",
  ]) {
    assert.equal(matcher.test(path), true, `${path} must not be caught by a prefix exclusion`);
  }
});
