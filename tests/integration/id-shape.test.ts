// The id-shape guard exists so a malformed URL id resolves to "not found"
// before any datastore query. The old `^[0-9a-f-]{36}$` check let through
// strings that satisfy length and charset but are not UUIDs (36 dashes, 36
// zeros). The Supabase adapter then sent `uuid = '----'`, which is an
// invalid-input syntax error, and /takeover/<id>, /success/<id>,
// /checkout/return?quote_id=<id>, and both OG routes returned 500 to anyone
// who could type a URL.
import assert from "node:assert/strict";
import test from "node:test";
import { isIdShaped } from "../../src/lib/repo/shared.ts";

test("canonical UUIDs are id-shaped", () => {
  assert.equal(isIdShaped("00000000-0000-4000-8000-000000000000"), true);
  assert.equal(isIdShaped("3f2504e0-4f89-41d3-9a0c-0305e82c3301"), true);
  assert.equal(isIdShaped("3F2504E0-4F89-41D3-9A0C-0305E82C3301"), true);
  assert.equal(isIdShaped(crypto.randomUUID()), true);
});

test("36-character non-UUIDs are not id-shaped", () => {
  for (const value of [
    "------------------------------------",
    "000000000000000000000000000000000000",
    "00000000-0000-0000-0000-00000000000", // 35 chars
    "00000000-0000-0000-0000-0000000000000", // 37 chars
    "00000000-0000-4000-8000-00000000000g",
    "000000000000-0000-4000-8000-00000000", // misplaced hyphens
    "00000000_0000_4000_8000_000000000000",
  ]) {
    assert.equal(isIdShaped(value), false, `${value} must not reach a uuid query`);
  }
});
