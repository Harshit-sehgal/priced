import assert from "node:assert/strict";
import test from "node:test";
import type { DomainRecord } from "./game.ts";
import { applyTakeover, isPlausibleDomain, normalizeDomain, quoteFor } from "./game.ts";

function record(priceCents: number, holder: string | null = "@old", version = 1): DomainRecord {
  return { domain: "example.com", holder, priceCents, version, history: [] };
}

test("normalizes URLs to canonical domains", () => {
  assert.equal(normalizeDomain(" HTTPS://WWW.OpenAI.com/foo?q=1 "), "openai.com");
});

test("unclaimed domains start at $5", () => {
  assert.equal(quoteFor(record(0, null, 0)).nextPriceCents, 500);
});

test("a first claim may offer more than the $5 minimum", () => {
  const base = record(0, null, 0);
  const result = applyTakeover(base, "@new", 0, 1250);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.record.priceCents, 1250);
});

test("$5 minimum increment wins below $500", () => {
  assert.equal(quoteFor(record(9400)).nextPriceCents, 9900);
});

test("1% increment wins above $500", () => {
  const q = quoteFor(record(94000));
  assert.equal(q.percentIncrementCents, 940);
  assert.equal(q.requiredIncrementCents, 940);
  assert.equal(q.nextPriceCents, 94940);
});

test("$500 is the exact crossover: both increments equal $5", () => {
  const q = quoteFor(record(50000));
  assert.equal(q.percentIncrementCents, 500);
  assert.equal(q.requiredIncrementCents, 500);
  assert.equal(q.nextPriceCents, 50500);
});

test("1% is rounded upward to the next cent", () => {
  const q = quoteFor(record(50001));
  assert.equal(q.percentIncrementCents, 501);
  assert.equal(q.requiredIncrementCents, 501);
  assert.equal(q.nextPriceCents, 50502);
});

test("domain validation rejects malformed hostnames", () => {
  assert.equal(isPlausibleDomain("openai.com"), true);
  assert.equal(isPlausibleDomain("not a domain"), false);
  assert.equal(isPlausibleDomain("example..com"), false);
});

test("$4,280 becomes $4,322.80", () => {
  assert.equal(quoteFor(record(428000)).nextPriceCents, 432280);
});

test("offers below the computed minimum are rejected", () => {
  const result = applyTakeover(record(500, "@old", 1), "@new", 1, 999);
  assert.deepEqual(result, { ok: false, code: "WRONG_PRICE" });
});

test("a takeover offer may exceed the computed minimum", () => {
  const result = applyTakeover(record(500, "@old", 1), "@new", 1, 2500);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.record.priceCents, 2500);
});

test("current holder cannot take over their own tag", () => {
  const base = record(94000, "@same", 3);
  assert.deepEqual(applyTakeover(base, "@SAME", 3, 94940), {
    ok: false,
    code: "ALREADY_HOLDER",
  });
});

test("takeover rejects a stale quote", () => {
  const result = applyTakeover(record(94000, "@old", 3), "@new", 2, 94940);
  assert.deepEqual(result, { ok: false, code: "STALE_QUOTE" });
});

test("successful takeover increments version and appends immutable history", () => {
  const base = record(94000, "@old", 3);
  const result = applyTakeover(base, "@new", 3, 94940, "2026-09-08T00:00:00.000Z");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.record.holder, "@new");
  assert.equal(result.record.priceCents, 94940);
  assert.equal(result.record.version, 4);
  assert.equal(result.record.history.length, 1);
});
