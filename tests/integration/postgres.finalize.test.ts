// Real Postgres harness for `finalize_takeover` (spec §18 / item 7).
// Runs against a live Supabase Postgres via SUPABASE_SERVICE_ROLE_KEY.
// Skips in CI (no credentials) — run in staging with RUN_POSTGRES_TESTS=1.
//
// Usage:
//   RUN_POSTGRES_TESTS=1 NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run test:postgres
//
// Each test uses a unique domain (pgtest-<ts>-*.com) so parallel runs never
// collide. The suite removes its disposable domains and sales after the run;
// it proves row locking, version checks, first-claim races, duplicate payment
// ids, wrong amounts, stale versions, self-takeovers and reserved-domain
// rollback against the REAL PL/pgSQL function, not the in-memory mirror.

import assert from "node:assert/strict";
import test, { describe } from "node:test";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const enabled = Boolean(url && key && process.env.RUN_POSTGRES_TESTS);

// Lazy load so CI without supabase-js env still parses the file.
async function sb() {
  const { createClient } = await import("@supabase/supabase-js");
  return createClient(url!, key!, { auth: { persistSession: false, autoRefreshToken: false } });
}

function skipReason(): string {
  if (!url || !key) return "Supabase credentials not set (set NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)";
  if (!process.env.RUN_POSTGRES_TESTS) return "Set RUN_POSTGRES_TESTS=1 to run real-Postgres tests";
  return "";
}

function uniq(prefix: string): string {
  const domain = `pgtest-${Date.now().toString(36)}-${prefix}-${Math.random().toString(36).slice(2, 6)}.com`;
  testDomains.add(domain);
  return domain;
}

const testDomains = new Set<string>();

async function cleanupTestData(): Promise<void> {
  if (!enabled || testDomains.size === 0) return;
  const client = await sb();
  const domains = [...testDomains];
  const errors: string[] = [];
  for (const table of ["quotes", "reserved_domains", "sales", "domains"]) {
    const { error } = await client.from(table).delete().in("domain", domains);
    if (error) errors.push(`${table}: ${error.message}`);
  }
  if (errors.length > 0) throw new Error(`postgres harness cleanup failed: ${errors.join("; ")}`);
}

function uuid(): string {
  return crypto.randomUUID();
}

type RpcResult = { data: unknown; error: { message: string; code?: string } | null };

async function finalize(args: {
  domain: string;
  buyerUserId: string;
  buyerHandle: string;
  expectedVersion: number;
  paidCents: number;
  providerPaymentId: string;
}): Promise<RpcResult> {
  const client = await sb();
  const { data, error } = await client.rpc("finalize_takeover", {
    p_domain: args.domain,
    p_buyer_user_id: args.buyerUserId,
    p_buyer_handle: args.buyerHandle,
    p_expected_version: args.expectedVersion,
    p_paid_cents: args.paidCents,
    p_provider_payment_id: args.providerPaymentId,
  });
  return { data, error: error as RpcResult["error"] };
}

function codeOf(err: { message: string } | null): string {
  if (!err) return "OK";
  return (err.message.split(" ")[0] ?? "").replace(/["']/g, "");
}

describe("postgres finalize_takeover (real DB)", () => {
  test.after(async () => {
    await cleanupTestData();
  });

  test.beforeEach(() => {
    if (!enabled) return;
    // no per-test setup; each test uses a fresh domain/payment id.
  });

  test("skips cleanly when not configured", () => {
    if (enabled) return; // real run — not a skip test
    assert.ok(skipReason().length > 0, "expected a skip reason in CI");
  });

  // The real tests are gated behind `enabled` via `test(..., { skip })`.
  // Using the `skip` option keeps the runner green in CI while still
  // showing the tests as skipped.

  test("first-claim race — exactly one winner (row lock)", { skip: !enabled }, async () => {
    const domain = uniq("race1");
    const a = uuid();
    const b = uuid();
    const [rA, rB] = await Promise.all([
      finalize({ domain, buyerUserId: a, buyerHandle: "alice", expectedVersion: 0, paidCents: 500, providerPaymentId: `pi-${a.slice(0, 8)}` }),
      finalize({ domain, buyerUserId: b, buyerHandle: "bob", expectedVersion: 0, paidCents: 500, providerPaymentId: `pi-${b.slice(0, 8)}` }),
    ]);
    const wins = [rA, rB].filter((r) => !r.error);
    const stales = [rA, rB].filter((r) => codeOf(r.error) === "STALE_QUOTE");
    assert.equal(wins.length, 1, `one winner, got ${JSON.stringify([codeOf(rA.error), codeOf(rB.error)])}`);
    assert.equal(stales.length, 1);
  });

  test("takeover race at $940 — exactly one winner", { skip: !enabled }, async () => {
    const domain = uniq("race2");
    const owner = uuid();
    const first = await finalize({ domain, buyerUserId: owner, buyerHandle: "owner", expectedVersion: 0, paidCents: 500, providerPaymentId: `pi-${owner.slice(0, 8)}` });
    assert.equal(codeOf(first.error), "OK", first.error?.message ?? "");
    // Next price after $5 is $10 (500 + 500), then 1050, ... but we just
    // claimed; the next price for the race is 1000. Prove contention there.
    const expectedNext = 1000;
    const a = uuid();
    const b = uuid();
    const [rA, rB] = await Promise.all([
      finalize({ domain, buyerUserId: a, buyerHandle: "alice", expectedVersion: 1, paidCents: expectedNext, providerPaymentId: `pi-${a.slice(0, 8)}` }),
      finalize({ domain, buyerUserId: b, buyerHandle: "bob", expectedVersion: 1, paidCents: expectedNext, providerPaymentId: `pi-${b.slice(0, 8)}` }),
    ]);
    const wins = [rA, rB].filter((r) => !r.error);
    assert.equal(wins.length, 1, `one takeover winner, got ${JSON.stringify([codeOf(rA.error), codeOf(rB.error)])}`);
  });

  test("stale version cannot overwrite", { skip: !enabled }, async () => {
    const domain = uniq("stale");
    const owner = uuid();
    await finalize({ domain, buyerUserId: owner, buyerHandle: "owner", expectedVersion: 0, paidCents: 500, providerPaymentId: `pi-${owner.slice(0, 8)}` });
    const alice = uuid();
    const aliceRes = await finalize({ domain, buyerUserId: alice, buyerHandle: "alice", expectedVersion: 1, paidCents: 1000, providerPaymentId: `pi-${alice.slice(0, 8)}` });
    assert.equal(codeOf(aliceRes.error), "OK", aliceRes.error?.message ?? "");
    const bob = uuid();
    const bobRes = await finalize({ domain, buyerUserId: bob, buyerHandle: "bob", expectedVersion: 1, paidCents: 1000, providerPaymentId: `pi-${bob.slice(0, 8)}` });
    assert.equal(codeOf(bobRes.error), "STALE_QUOTE");
  });

  test("duplicate payment id is idempotent, mismatched reuse is IDEMPOTENCY_CONFLICT", { skip: !enabled }, async () => {
    const domain = uniq("idem");
    const buyer = uuid();
    const pid = `pi-${buyer.slice(0, 8)}-idem`;
    const r1 = await finalize({ domain, buyerUserId: buyer, buyerHandle: "carol", expectedVersion: 0, paidCents: 500, providerPaymentId: pid });
    assert.equal(codeOf(r1.error), "OK", r1.error?.message ?? "");
    const r2 = await finalize({ domain, buyerUserId: buyer, buyerHandle: "carol", expectedVersion: 0, paidCents: 500, providerPaymentId: pid });
    assert.equal(codeOf(r2.error), "OK", "same payment id with same args must be idempotent");
    // shallow compare sales ids if returned
    const id1 = (r1.data as { id?: string } | null)?.id;
    const id2 = (r2.data as { id?: string } | null)?.id;
    if (id1 && id2) assert.equal(id1, id2);

    const otherDomain = uniq("idem2");
    const r3 = await finalize({ domain: otherDomain, buyerUserId: uuid(), buyerHandle: "erin", expectedVersion: 0, paidCents: 500, providerPaymentId: pid });
    assert.equal(codeOf(r3.error), "IDEMPOTENCY_CONFLICT");
  });

  test("wrong amount is rejected", { skip: !enabled }, async () => {
    const domain = uniq("wrong");
    const buyer = uuid();
    const res = await finalize({ domain, buyerUserId: buyer, buyerHandle: "frank", expectedVersion: 0, paidCents: 499, providerPaymentId: `pi-${buyer.slice(0, 8)}` });
    assert.equal(codeOf(res.error), "WRONG_PRICE");
  });

  test("self-takeover is rejected", { skip: !enabled }, async () => {
    const domain = uniq("self");
    const buyer = uuid();
    const r1 = await finalize({ domain, buyerUserId: buyer, buyerHandle: "solo", expectedVersion: 0, paidCents: 500, providerPaymentId: `pi-${buyer.slice(0, 8)}` });
    assert.equal(codeOf(r1.error), "OK", r1.error?.message ?? "");
    const r2 = await finalize({ domain, buyerUserId: buyer, buyerHandle: "solo", expectedVersion: 1, paidCents: 1000, providerPaymentId: `pi-${buyer.slice(0, 8)}-2` });
    assert.equal(codeOf(r2.error), "ALREADY_HOLDER");
  });

  test("reserved domain rolls back (no sale, no holder)", { skip: !enabled }, async () => {
    const domain = uniq("reserved");
    const client = await sb();
    // Idempotent setup: clear any stale reservation from a previous run, then
    // reserve. If the insert fails, the harness cannot prove anything, so this
    // FAILS instead of silently continuing and accepting whatever comes back.
    await client.from("reserved_domains").delete().eq("domain", domain);
    const { error: resErr } = await client.from("reserved_domains").insert({ domain, reason: "test harness", created_by: "postgres.test" });
    assert.ok(!resErr, `harness could not reserve ${domain}: ${resErr?.message}`);

    const buyer = uuid();
    const res = await finalize({ domain, buyerUserId: buyer, buyerHandle: "mallory", expectedVersion: 0, paidCents: 500, providerPaymentId: `pi-${buyer.slice(0, 8)}` });
    // This harness calls the raw RPC, so the code is the SQL guard's own
    // RESERVED_DOMAIN — not the FINALIZE_ERROR repo.ts maps it to.
    assert.equal(codeOf(res.error), "RESERVED_DOMAIN", res.error?.message ?? "expected a reserved-domain rejection");

    // Cleanup: best-effort unreserve so the test domain doesn't stay blocked.
    await client.from("reserved_domains").delete().eq("domain", domain);
  });
});
