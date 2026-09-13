// CTA + bio validation (§7) and /api/profile contract.
import assert from "node:assert/strict";
import test from "node:test";
import { holderCtaVisible, validateCta, validateBio } from "../../src/lib/cta.ts";

// Suspension hides a profile, so its outbound CTA must be hidden on every
// surface that still links the handle (tags they hold). The handle itself
// stays visible — holdings are ledger truth.
test("cta: a suspended holder's CTA is not visible", () => {
  assert.equal(holderCtaVisible(null), false);
  assert.equal(holderCtaVisible(undefined), false);
  assert.equal(holderCtaVisible({ suspendedAt: null }), true);
  const suspendedAt = new Date().toISOString();
  assert.equal(holderCtaVisible({ suspendedAt }), false);
});

test("cta: requires both label and url when either is provided", () => {
  assert.deepEqual(validateCta("Visit my site", ""), { ok: false, reason: "url_required" });
  assert.deepEqual(validateCta("", "https://x.com"), { ok: false, reason: "label_required" });
  assert.deepEqual(validateCta("", ""), { ok: false, reason: "label_required" });
});

test("cta: https-only, full URL required", () => {
  assert.equal(validateCta("Go", "http://x.com").ok, false);
  assert.equal(validateCta("Go", "ftp://x.com").ok, false);
  assert.equal(validateCta("Go", "javascript:alert(1)").ok, false);
  assert.equal(validateCta("Go", "notaurl").ok, false);
  const ok = validateCta("Go", "https://example.com");
  assert.ok(ok.ok);
  if (ok.ok) assert.equal(ok.url, "https://example.com/");
});

test("cta: label and url length caps", () => {
  assert.equal(validateCta("x".repeat(41), "https://example.com").ok, false);
  assert.equal(validateCta("ok", "https://example.com/" + "a".repeat(300)).ok, false);
});

test("cta: whitespace trimmed", () => {
  const ok = validateCta("  Visit my startup  ", "  https://example.com  ");
  assert.ok(ok.ok);
  if (ok.ok) assert.equal(ok.label, "Visit my startup");
});

test("cta: rejects links back into Priced itself", () => {
  process.env.NEXT_PUBLIC_APP_URL = "https://priced.game";
  try {
    assert.equal(validateCta("Home", "https://priced.game").ok, false);
    assert.equal(validateCta("Home", "https://priced.game/domain/x.com").ok, false);
    assert.ok(validateCta("Elsewhere", "https://example.com").ok);
  } finally {
    delete process.env.NEXT_PUBLIC_APP_URL;
  }
});

test("bio: null, empty and trimmed-long inputs", () => {
  assert.deepEqual(validateBio(null), { ok: true, bio: null });
  assert.deepEqual(validateBio(""), { ok: true, bio: null });
  assert.deepEqual(validateBio("  hi  "), { ok: true, bio: "hi" });
  assert.equal(validateBio("x".repeat(281)).ok, false);
  assert.deepEqual(validateBio("x".repeat(280)), { ok: true, bio: "x".repeat(280) });
});

test("cta: rejects dangerous and exotic protocols (§22 regression)", () => {
  // validateCta accepts ONLY https; every other scheme must fail.
  const dangerous = [
    "javascript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "file:///etc/passwd",
    "ftp://files.example.com",
    "ws://example.com",
    "vbscript:msgbox(1)",
    "://example.com",
    "//example.com",           // protocol-relative: no scheme
    "notaurl",
    "  ",
  ];
  for (const url of dangerous) {
    const res = validateCta("Go", url);
    assert.equal(res.ok, false, `must reject ${url}`);
  }
  // The one true scheme still passes. Lenient WHATWG forms like
  // "https:/example.com" and "https:example.com" NORMALIZE to the same
  // https origin; accepting the normalized form is safe, and the stored
  // value is the canonical URL, never the raw input.
  const normalized = validateCta("Go", "https:example.com");
  assert.ok(normalized.ok);
  if (normalized.ok) assert.equal(normalized.url, "https://example.com/");
  assert.ok(validateCta("Go", "https://example.com").ok);
});

// NEXT_PUBLIC_APP_URL is a build-time constant that goes stale the moment the
// deployment moves — this app has already gone Vercel -> Cloudflare Workers.
// During that window the self-host guard blocked a host nobody was served from
// while the LIVE host was allowed, so a holder could point their CTA back into
// Priced. A CTA on our own domain labelled "Verify ownership" borrows the
// site's legitimacy to phish our own users, so the guard has to key on the
// host the request actually arrived on, not only the configured one.
test("cta: the host actually serving the request counts as self, even if config is stale", () => {
  const previous = process.env.NEXT_PUBLIC_APP_URL;
  process.env.NEXT_PUBLIC_APP_URL = "https://old-host.example"; // stale config
  try {
    const live = "priced.harshit10sehgal.workers.dev";
    const stale = validateCta("Verify ownership", `https://${live}/login`);
    assert.equal(stale.ok, true, "without the served host the live domain slips through");

    const guarded = validateCta("Verify ownership", `https://${live}/login`, [live]);
    assert.equal(guarded.ok, false, "the live host must be treated as self");
    if (!guarded.ok) assert.equal(guarded.reason, "host_reserved");

    // The configured host stays blocked too — both definitions of "us" apply.
    const configured = validateCta("Home", "https://old-host.example/x", [live]);
    assert.equal(configured.ok, false);

    // Case and port handling must not be a bypass.
    assert.equal(validateCta("x", `https://${live.toUpperCase()}/a`, [live]).ok, false);

    // A genuinely external link is still fine.
    assert.equal(validateCta("My site", "https://example.com/me", [live]).ok, true);
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = previous;
  }
});
