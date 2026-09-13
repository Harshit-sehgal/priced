import assert from "node:assert/strict";
import test from "node:test";
import { safeDecodeURIComponent, sanitizeInternalPath } from "../../src/lib/navigation.ts";

test("sanitizeInternalPath keeps same-origin relative paths", () => {
  assert.equal(sanitizeInternalPath("/"), "/");
  assert.equal(sanitizeInternalPath("/domain/openai.com"), "/domain/openai.com");
  assert.equal(sanitizeInternalPath("/takeover/abc?via=share#pay"), "/takeover/abc?via=share#pay");
});

test("sanitizeInternalPath rejects external and scheme-relative redirects", () => {
  for (const value of [
    "https://evil.example",
    "http://evil.example",
    "//evil.example/path",
    "///evil.example/path",
    "/\\evil.example/path",
    "javascript:alert(1)",
    "data:text/html,hello",
    "evil.example/path",
    "",
    null,
    undefined,
  ]) {
    assert.equal(sanitizeInternalPath(value), "/", String(value));
  }
});

test("sanitized output cannot change origin when resolved", () => {
  const origin = "https://priced.example";
  for (const value of [
    "/profile",
    "/?next=https://evil.example",
    "/%5cevil.example",
    "/%2f%2fevil.example",
    "/\\evil.example",
    "//evil.example",
  ]) {
    const safe = sanitizeInternalPath(value);
    assert.equal(new URL(safe, origin).origin, origin, value);
  }
});

// Regression: dot-segment traversal that NORMALISES into a protocol-relative
// path. These start with a single "/" and resolve to the sentinel origin, so
// an input-only check accepts them — but their pathname collapses to
// "//evil.example", which becomes https://evil.example once the caller
// resolves it against the real origin. This is the open-redirect that turned
// a genuine /auth/callback login into an attacker-controlled landing page.
test("traversal that normalises into a protocol-relative path is rejected", () => {
  const origin = "https://priced.example";
  for (const value of [
    "/..//evil.example",
    "/..//evil.example/login",
    "/../..///evil.example/x",
    "/./..//evil.example",
    "/a/b/../../..//evil.example",
  ]) {
    const safe = sanitizeInternalPath(value);
    assert.ok(!safe.startsWith("//"), `${value} -> ${safe} is protocol-relative`);
    assert.equal(new URL(safe, origin).origin, origin, value);
  }
});

test("legitimate internal paths survive sanitisation unchanged", () => {
  for (const value of [
    "/",
    "/domain/openai.com",
    "/u/harshit/analytics",
    "/takeover/abc?via=share#pay",
    "/success/1?via=share",
  ]) {
    assert.equal(sanitizeInternalPath(value), value);
  }
});

// Route params are percent-decoded before validation. decodeURIComponent
// throws URIError on malformed escapes, which surfaced as an unauthenticated
// 500 on /domain/% and /u/% — public GETs that bots hit trivially. The decoder
// must return the raw value and let the validators reject it.
test("safeDecodeURIComponent never throws on malformed escapes", () => {
  assert.equal(safeDecodeURIComponent("openai.com"), "openai.com");
  assert.equal(safeDecodeURIComponent("openai%2Ecom"), "openai.com");
  assert.equal(safeDecodeURIComponent("%"), "%");
  assert.equal(safeDecodeURIComponent("%zz"), "%zz");
  assert.equal(safeDecodeURIComponent("100%"), "100%");
  assert.equal(safeDecodeURIComponent("%E0%A4%A"), "%E0%A4%A");
  assert.equal(safeDecodeURIComponent("a%2Fb"), "a/b");
});
