// Local Postgres harness for the finalize_takeover RPC (checklist item 7,
// in-repo half). Boots a disposable postgres:16-alpine container, applies
// supabase/migrations, and runs the money-path race suite against REAL
// Postgres row locking — the same semantics production Supabase uses.
//
// Skips cleanly (exit 0) when Docker isn't available, so CI stays green on
// runners without Docker; the real-project verification remains an owner gate.
//
// Usage: node --experimental-strip-types tests/pg/finalize-rpc.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DOCKER_IMAGE = "postgres:16-alpine";
// Unique per run, and the host port is assigned by Docker (`-p 0:5432`).
//
// A FIXED name + port made concurrent runs destroy each other: the harness
// `docker rm -f`s the name before booting, so a second run killed the first
// run's database and every test in it failed at once. That reads exactly like
// "the money path is broken" — the most expensive possible false alarm, and it
// matters more now that CI runs `test:pg` and `test:schema` as gates. A red
// build nobody trusts is worse than no build.
const CONTAINER = `ipt-finalize-rpc-test-${process.pid}-${randomUUID().slice(0, 8)}`;
let POSTGRES_URL = "";

function sh(cmd: string, ...args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function dockerAvailable() {
  const r = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8" });
  return r.status === 0;
}

// Pool (not a single client): the concurrency tests fire many parallel
// finalize_takeover calls, which a shared pg.Client cannot multiplex.
async function connectPool(retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      const pool = new pg.Pool({ connectionString: POSTGRES_URL, max: 25 });
      await pool.query("select 1");
      return pool;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("postgres did not become ready in time");
}

async function runMigrations(client: pg.Client | pg.Pool): Promise<void> {
  const { readFile } = await import("node:fs/promises");

  // Supabase-compat preamble: plain Postgres lacks the service_role role,
  // the auth schema and the realtime publication the migrations reference.
  await client.query("create role service_role nologin");
  await client.query("create role anon nologin");
  await client.query("create role authenticated nologin");
  await client.query("create schema if not exists auth");
  await client.query("create table if not exists auth.users (id uuid primary key, email text, created_at timestamptz default now())");
  // auth.uid() stub for the quotes owner-read RLS policy.
  await client.query("create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$");
  await client.query("create publication supabase_realtime");

  // Apply EVERY migration in filename order rather than a hardcoded list.
  // A hardcoded list silently rots: it had already drifted past
  // 20260910000004_hosted_supabase_hardening.sql, so this harness was
  // certifying an OUTDATED finalize_takeover — exactly the function these
  // tests exist to prove. Globbing means a new migration is covered the
  // moment it lands, which is the only way "fresh DB boots from
  // supabase/migrations/" stays true.
  const { readdir } = await import("node:fs/promises");
  const dir = new URL("../../supabase/migrations/", import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  if (files.length === 0) throw new Error("no migrations found");
  for (const file of files) {
    const sql = await readFile(new URL(file, dir), "utf8");
    await client.query(sql);
  }
}

const hasDocker = dockerAvailable();
if (!hasDocker) {
  console.warn("[finalize-rpc] Docker not available — skipping real-Postgres RPC tests.");
}

// Shared state: one container for the whole file (booting per-test is slow).
let client: pg.Pool;

test.before(async () => {
  if (!hasDocker) return;
  // The name is unique per run, so there is no stale container to remove and
  // nothing another concurrent run could be using.
  sh(
    "docker", "run", "-d", "--name", CONTAINER,
    "-e", "POSTGRES_USER=ipt", "-e", "POSTGRES_PASSWORD=ipt", "-e", "POSTGRES_DB=ipt",
    "-p", "0:5432", // let Docker pick a free host port — no port races either
    "--health-cmd", "pg_isready -U ipt", "--health-interval=1s", "--health-timeout=1s", "--health-retries=15",
    DOCKER_IMAGE,
  );
  // "0.0.0.0:49154" (and possibly a second IPv6 line) -> take the port.
  const mapped = sh("docker", "port", CONTAINER, "5432/tcp").trim().split("\n")[0];
  const hostPort = mapped.slice(mapped.lastIndexOf(":") + 1);
  if (!/^\d+$/.test(hostPort)) throw new Error(`could not resolve mapped port from "${mapped}"`);
  POSTGRES_URL = `postgres://ipt:ipt@127.0.0.1:${hostPort}/ipt`;
  client = await connectPool();
  await runMigrations(client);
});

test.after(async () => {
  if (client) await client.end().catch(() => {});
  if (hasDocker) spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
});

// ----------------------------------------------------------------- helpers
async function seedProfile(handle: string): Promise<string> {
  const id = randomUUID();
  // profiles.id normally references auth.users — create a stub auth user row.
  await client.query(
    `insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`,
    [id, `${handle}@rpc-test.local`],
  );
  await client.query(
    `insert into public.profiles (id, handle) values ($1, $2)`,
    [id, handle],
  );
  return id;
}

type FinalizeArgs = {
  domain: string;
  buyerUserId: string;
  buyerHandle: string;
  expectedVersion: number | null;
  paidCents: number | null;
  providerPaymentId: string;
};

async function finalize(args: FinalizeArgs): Promise<
  { ok: true; sale: Record<string, string> } | { ok: false; code: string }
> {
  try {
    const res = await client.query("select * from public.finalize_takeover($1,$2,$3,$4,$5,$6)", [
      args.domain, args.buyerUserId, args.buyerHandle, args.expectedVersion,
      args.paidCents, args.providerPaymentId,
    ]);
    return { ok: true, sale: res.rows[0] };
  } catch (e) {
    const code = String(e instanceof Error ? e.message : e).split(" ")[0].replace(/["']/g, "");
    return { ok: false, code };
  }
}

// ------------------------------------------------------------------- tests
test("first claim at the start price creates domain + sale", { skip: !hasDocker }, async () => {
  const userId = await seedProfile("rpc-first");
  const out = await finalize({
    domain: "rpc-first.com", buyerUserId: userId, buyerHandle: "rpc-first",
    expectedVersion: 0, paidCents: 500, providerPaymentId: "pi-rpc-first-1",
  });
  assert.ok(out.ok, `first claim failed: ${JSON.stringify(out)}`);
  assert.equal(out.sale.price_cents, "500");
  assert.equal(out.sale.domain_version, "1");
  const d = await client.query("select * from public.domains where domain = 'rpc-first.com'");
  assert.equal(d.rows[0].version, "1");
  assert.equal(d.rows[0].holder_handle, "rpc-first");
});

test("idempotent replay: same payment id returns the same sale", { skip: !hasDocker }, async () => {
  const userId = await seedProfile("rpc-replay");
  const first = await finalize({
    domain: "rpc-replay.com", buyerUserId: userId, buyerHandle: "rpc-replay",
    expectedVersion: 0, paidCents: 500, providerPaymentId: "pi-rpc-replay-1",
  });
  assert.ok(first.ok);
  const second = await finalize({
    domain: "rpc-replay.com", buyerUserId: userId, buyerHandle: "rpc-replay",
    expectedVersion: 0, paidCents: 500, providerPaymentId: "pi-rpc-replay-1",
  });
  assert.ok(second.ok);
  assert.equal(second.sale.id, first.sale.id, "replay must return the identical sale row");
  const count = await client.query("select count(*)::int as n from public.sales where domain = 'rpc-replay.com'");
  assert.equal(count.rows[0].n, 1, "replay must not create a second sale");
});

test("wrong price is rejected with WRONG_PRICE", { skip: !hasDocker }, async () => {
  const userId = await seedProfile("rpc-price");
  const out = await finalize({
    domain: "rpc-price.com", buyerUserId: userId, buyerHandle: "rpc-price",
    expectedVersion: 0, paidCents: 999, providerPaymentId: "pi-rpc-price-1",
  });
  assert.ok(!out.ok);
  assert.equal(out.code, "WRONG_PRICE");
});

// `x <> NULL` is NULL, which an `if` treats as false — so a NULL argument used
// to SKIP its guard instead of failing it. These calls are service-role-only
// (the webhook always passes numbers), but a guard that vanishes on NULL is
// not a guard. Migration 20260913000002 makes each comparison explicit.
test("a NULL expected version cannot skip the staleness guard", { skip: !hasDocker }, async () => {
  const userId = await seedProfile("rpc-null-version");
  // Move the domain to version 1 so there is a real stale state to skip past.
  await finalize({
    domain: "rpc-null-version.com", buyerUserId: userId, buyerHandle: "rpc-null-version",
    expectedVersion: 0, paidCents: 500, providerPaymentId: "pi-rpc-null-version-0",
  });
  const other = await seedProfile("rpc-null-version-2");
  const out = await finalize({
    domain: "rpc-null-version.com", buyerUserId: other, buyerHandle: "rpc-null-version-2",
    expectedVersion: null, paidCents: 1000, providerPaymentId: "pi-rpc-null-version-1",
  });
  assert.ok(!out.ok);
  assert.equal(out.code, "STALE_QUOTE", "NULL must not finalize over a stale market");
});

test("a NULL paid amount cannot skip the price guard", { skip: !hasDocker }, async () => {
  const userId = await seedProfile("rpc-null-price");
  const out = await finalize({
    domain: "rpc-null-price.com", buyerUserId: userId, buyerHandle: "rpc-null-price",
    expectedVersion: 0, paidCents: null, providerPaymentId: "pi-rpc-null-price-0",
  });
  assert.ok(!out.ok);
  assert.equal(out.code, "WRONG_PRICE", "NULL must not mint a sale");
});

test("a NULL amount on a replay is a conflict, not a matching sale", { skip: !hasDocker }, async () => {
  const userId = await seedProfile("rpc-null-replay");
  await finalize({
    domain: "rpc-null-replay.com", buyerUserId: userId, buyerHandle: "rpc-null-replay",
    expectedVersion: 0, paidCents: 500, providerPaymentId: "pi-rpc-null-replay-0",
  });
  const replay = await finalize({
    domain: "rpc-null-replay.com", buyerUserId: userId, buyerHandle: "rpc-null-replay",
    expectedVersion: 0, paidCents: null, providerPaymentId: "pi-rpc-null-replay-0",
  });
  assert.ok(!replay.ok);
  assert.equal(replay.code, "IDEMPOTENCY_CONFLICT");
});

test("stale version is rejected with STALE_QUOTE", { skip: !hasDocker }, async () => {
  const a = await seedProfile("rpc-holda");
  const b = await seedProfile("rpc-holdb");
  await finalize({
    domain: "rpc-stale.com", buyerUserId: a, buyerHandle: "rpc-holda",
    expectedVersion: 0, paidCents: 500, providerPaymentId: "pi-rpc-stale-0",
  });
  const out = await finalize({
    domain: "rpc-stale.com", buyerUserId: b, buyerHandle: "rpc-holdb",
    expectedVersion: 0, paidCents: 555, providerPaymentId: "pi-rpc-stale-1",
  });
  assert.ok(!out.ok);
  assert.equal(out.code, "STALE_QUOTE");
});

test("already holder is rejected with ALREADY_HOLDER", { skip: !hasDocker }, async () => {
  const userId = await seedProfile("rpc-same");
  await finalize({
    domain: "rpc-same.com", buyerUserId: userId, buyerHandle: "rpc-same",
    expectedVersion: 0, paidCents: 500, providerPaymentId: "pi-rpc-same-0",
  });
  const out = await finalize({
    domain: "rpc-same.com", buyerUserId: userId, buyerHandle: "rpc-same",
    expectedVersion: 1, paidCents: 505, providerPaymentId: "pi-rpc-same-1",
  });
  assert.ok(!out.ok);
  assert.equal(out.code, "ALREADY_HOLDER");
});

test("reserved domain is rejected inside the transaction", { skip: !hasDocker }, async () => {
  const userId = await seedProfile("rpc-res");
  await client.query(
    `insert into public.reserved_domains (domain, reason, created_by) values ('rpc-reserved.com', 'test', 'rpc-test')`,
  );
  const out = await finalize({
    domain: "rpc-reserved.com", buyerUserId: userId, buyerHandle: "rpc-res",
    expectedVersion: 0, paidCents: 500, providerPaymentId: "pi-rpc-res-1",
  });
  assert.ok(!out.ok);
  assert.equal(out.code, "RESERVED_DOMAIN");
});

test("refund claim RPC serializes attempts and reaches manual review", { skip: !hasDocker }, async () => {
  const provider = "dodo";
  const paymentId = `pi-refund-rpc-${randomUUID()}`;
  const claimArgs = [provider, paymentId, "evt-refund-rpc-1", "stale_quote", 500, 3, 600];
  const results = await Promise.all(
    Array.from({ length: 8 }, () => client.query(
      "select * from public.claim_refund_attempt($1,$2,$3,$4,$5,$6,$7)",
      claimArgs,
    )),
  );
  const claimed = results.filter((result) => result.rows[0]?.claimed);
  assert.equal(claimed.length, 1, `only one concurrent refund worker may claim the attempt: ${JSON.stringify(results.map((result) => result.rows[0]))}`);
  assert.equal(claimed[0].rows[0].attempts, 1);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await client.query(
      `update public.refunds
       set status = 'failed', claim_token = null, lease_expires_at = null,
           last_error = $1, updated_at = now()
       where provider = $2 and provider_payment_id = $3`,
      [`wallet failure ${attempt}`, provider, paymentId],
    );
    if (attempt < 3) {
      const retry = await client.query(
        "select * from public.claim_refund_attempt($1,$2,$3,$4,$5,$6,$7)",
        [provider, paymentId, `evt-refund-rpc-${attempt + 1}`, "stale_quote", 500, 3, 600],
      );
      assert.equal(retry.rows[0].claimed, true);
      assert.equal(retry.rows[0].attempts, attempt + 1);
    }
  }

  const terminal = await client.query(
    "select * from public.claim_refund_attempt($1,$2,$3,$4,$5,$6,$7)",
    [provider, paymentId, "evt-refund-rpc-4", "stale_quote", 500, 3, 600],
  );
  assert.equal(terminal.rows[0].claimed, false);
  assert.equal(terminal.rows[0].status, "manual_review");
  assert.equal(terminal.rows[0].attempts, 3);
});

test("25 concurrent first claims: exactly one winner, 24 clean losers (real row locks)", { skip: !hasDocker }, async () => {
  const domain = "rpc-race.com";
  const buyers = [];
  for (let i = 0; i < 25; i++) buyers.push(await seedProfile(`rpc-racer-${i}`));

  const attempts = await Promise.all(
    buyers.map((userId, i) =>
      finalize({
        domain, buyerUserId: userId, buyerHandle: `rpc-racer-${i}`,
        expectedVersion: 0, paidCents: 500, providerPaymentId: `pi-rpc-race-${i}`,
      }),
    ),
  );

  const winners = attempts.filter((a) => a.ok);
  const stale = attempts.filter((a) => !a.ok && a.code === "STALE_QUOTE");
  assert.equal(winners.length, 1, `exactly one winner, got ${winners.length}: ${JSON.stringify(attempts.filter(a => a.ok))}`);
  assert.equal(stale.length, 24, `24 stale losers, got ${stale.length} (other codes: ${JSON.stringify(attempts.filter(a => !a.ok).map(a => a.code))})`);

  const d = await client.query("select * from public.domains where domain = $1", [domain]);
  assert.equal(d.rows[0].version, "1");
  assert.ok(d.rows[0].holder_handle.startsWith("rpc-racer-"));
  const sales = await client.query("select count(*)::int as n from public.sales where domain = $1", [domain]);
  assert.equal(sales.rows[0].n, 1);
});

test("25 concurrent takeovers of a HELD domain: one winner at exactly +1% (min $5)", { skip: !hasDocker }, async () => {
  const domain = "rpc-race-held.com";
  const seedBuyer = await seedProfile("rpc-seed");
  await finalize({
    domain, buyerUserId: seedBuyer, buyerHandle: "rpc-seed",
    expectedVersion: 0, paidCents: 500, providerPaymentId: "pi-rpc-held-seed",
  });

  const buyers = [];
  for (let i = 0; i < 25; i++) buyers.push(await seedProfile(`rpc-chall-${i}`));

  // Held at $5.00 → increment = max($5, ceil(500/100)) = $5 → next price $10.00.
  const takeoverCents = 1000;
  const attempts = await Promise.all(
    buyers.map((userId, i) =>
      finalize({
        domain, buyerUserId: userId, buyerHandle: `rpc-chall-${i}`,
        expectedVersion: 1, paidCents: takeoverCents, providerPaymentId: `pi-rpc-held-${i}`,
      }),
    ),
  );

  const winners = attempts.filter((a) => a.ok);
  const stale = attempts.filter((a) => !a.ok && a.code === "STALE_QUOTE");
  assert.equal(winners.length, 1);
  assert.equal(
    stale.length,
    24,
    `24 stale losers, got ${stale.length} (other codes: ${JSON.stringify(attempts.filter((a) => !a.ok).map((a) => a.code))})`,
  );
  assert.equal(winners[0].sale.price_cents, String(takeoverCents));
  assert.equal(winners[0].sale.previous_price_cents, "500");
  const d = await client.query("select version, price_cents from public.domains where domain = $1", [domain]);
  assert.equal(d.rows[0].version, "2");
  assert.equal(d.rows[0].price_cents, String(takeoverCents));
});

test("IDEMPOTENCY_CONFLICT: same payment id with different args raises", { skip: !hasDocker }, async () => {
  const userId = await seedProfile("rpc-conflict");
  await finalize({
    domain: "rpc-conflict.com", buyerUserId: userId, buyerHandle: "rpc-conflict",
    expectedVersion: 0, paidCents: 500, providerPaymentId: "pi-rpc-conflict-1",
  });

  // SAME payment id, different amount → the fast-path conflict branch.
  const wrongAmount = await finalize({
    domain: "rpc-conflict.com", buyerUserId: userId, buyerHandle: "rpc-conflict",
    expectedVersion: 0, paidCents: 999, providerPaymentId: "pi-rpc-conflict-1",
  });
  assert.ok(!wrongAmount.ok);
  assert.equal(wrongAmount.code, "IDEMPOTENCY_CONFLICT");

  // SAME payment id, different domain/buyer → also a conflict, never a second
  // sale funded by one payment.
  const other = await seedProfile("rpc-conflict-2");
  const wrongDomain = await finalize({
    domain: "rpc-conflict-other.com", buyerUserId: other, buyerHandle: "rpc-conflict-2",
    expectedVersion: 0, paidCents: 500, providerPaymentId: "pi-rpc-conflict-1",
  });
  assert.ok(!wrongDomain.ok);
  assert.equal(wrongDomain.code, "IDEMPOTENCY_CONFLICT");

  // A different payment id is a normal second claim at the new price (stale
  // version), which is what this test previously conflated with a conflict.
  const freshPayment = await finalize({
    domain: "rpc-conflict.com", buyerUserId: other, buyerHandle: "rpc-conflict-2",
    expectedVersion: 0, paidCents: 500, providerPaymentId: "pi-rpc-conflict-2",
  });
  assert.ok(!freshPayment.ok);
  assert.equal(freshPayment.code, "STALE_QUOTE");
});

test("holder_analytics RPC aggregates real counts SQL-side", { skip: !hasDocker }, async () => {
  const userId = await seedProfile("rpc-analytics");
  await finalize({
    domain: "rpc-analytics.com", buyerUserId: userId, buyerHandle: "rpc-analytics",
    expectedVersion: 0, paidCents: 500, providerPaymentId: "pi-rpc-analytics-0",
  });

  // Seed analytics rows directly (service-role-equivalent access).
  await client.query(`
    insert into public.analytics_events (event, handle, domain, session_id, created_at) values
    ('tag_viewed', 'rpc-analytics', 'rpc-analytics.com', 's1', now()),
    ('tag_viewed', 'rpc-analytics', 'rpc-analytics.com', 's1', now()),
    ('tag_viewed', 'rpc-analytics', 'rpc-analytics.com', 's2', now()),
    ('tag_viewed', 'rpc-analytics', 'other.com', 's3', now()),
    ('tag_viewed', 'rpc-analytics', 'other.com', null, now()),
    ('profile_viewed', 'rpc-analytics', null, 's1', now()),
    ('share_visit', 'rpc-analytics', null, null, now()),
    ('cta_clicked', 'rpc-analytics', null, 's4', now()),
    ('tag_viewed', 'someone-else', 'rpc-analytics.com', 's5', now()),
    ('tag_viewed', 'rpc-analytics', 'rpc-analytics.com', 's1', now() - interval '40 days')
  `);

  const res = await client.query("select public.holder_analytics($1, $2) as out", [
    "rpc-analytics", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
  ]);
  const a = res.rows[0].out as {
    tag_views: number;
    tag_view_sessions: number;
    profile_views: number;
    share_visits: number;
    cta_clicks: number;
    by_domain: Array<{ domain: string; tag_views: number; unique_sessions: number }>;
    daily: Array<{ day: string; views: number }>;
  };
  assert.equal(a.tag_views, 5); // 3 own-domain + 2 other.com, excluding 40-day-old and someone-else
  assert.equal(a.tag_view_sessions, 3); // s1, s2, s3
  assert.equal(a.profile_views, 1);
  assert.equal(a.share_visits, 1);
  assert.equal(a.cta_clicks, 1);
  const byDomain = Object.fromEntries(a.by_domain.map((r) => [r.domain, r]));
  assert.equal(byDomain["rpc-analytics.com"].tag_views, 3);
  assert.equal(byDomain["rpc-analytics.com"].unique_sessions, 2);
  assert.equal(byDomain["other.com"].tag_views, 2);
  assert.equal(byDomain["other.com"].unique_sessions, 1);
  assert.ok(Array.isArray(a.daily) && a.daily.length >= 1);
  assert.ok(a.daily.every((d) => typeof d.day === "string" && typeof d.views === "number"));
});

// Regression for the finalize_takeover idempotency race (migration
// 20260912000001). The sales idempotency lookup used to run BEFORE
// `select ... for update` and was never repeated after the lock was held.
// Under READ COMMITTED a second delivery reads `sales` while the winner is
// still uncommitted (finds nothing), parks on the row lock, then wakes to a
// NEW version and raised STALE_QUOTE — for a payment that had already
// finalized. src/lib/takeover.ts REFUNDS on STALE_QUOTE, so the buyer kept
// the tag AND got their money back.
//
// Concurrency alone does not reproduce it: the two statements usually do not
// interleave inside the window. The interleaving is therefore forced here by
// holding the winner's transaction open while the loser blocks on the lock.
//
// Reachable in production whenever two DISTINCT webhook event ids for ONE
// payment arrive together — routine on Stripe, where checkout.session.completed
// and payment_intent.succeeded both map to "succeeded" for the same
// payment_intent.
test("concurrent duplicate delivery returns the existing sale, never STALE_QUOTE", { skip: !hasDocker }, async () => {
  const userId = await seedProfile("rpc-dupe");
  const domain = "rpc-dupe-race.com";
  const paymentId = "pi-rpc-dupe-race";
  const call = (c: pg.PoolClient) =>
    c.query("select * from public.finalize_takeover($1,$2,$3,$4,$5,$6)", [
      domain, userId, "rpc-dupe", 0, 500, paymentId,
    ]);

  const winner = await client.connect();
  const loser = await client.connect();
  try {
    await winner.query("begin");
    const first = await call(winner);
    const saleId = first.rows[0].id;

    // Second delivery starts while the winner is still uncommitted, so its
    // own sales lookup sees nothing and it parks on the domains row lock.
    await loser.query("begin");
    let resolved = false;
    const pending: Promise<{ ok: true; sale: Record<string, string> } | { ok: false; code: string }> = call(loser).then(
      (r) => {
        resolved = true;
        return { ok: true, sale: r.rows[0] };
      },
      (e: unknown) => {
        resolved = true;
        return { ok: false, code: String(e instanceof Error ? e.message : e).split(" ")[0] };
      },
    );
    await new Promise((r) => setTimeout(r, 400)); // let it reach the lock
    // Negative control: if the loser already resolved, it is NOT parked on the
    // lock and the interleaving below proves nothing.
    assert.equal(resolved, false, "loser must still be blocked on the row lock before the winner commits");
    await winner.query("commit");

    const second = await pending;
    await loser.query("commit").catch(() => {});

    assert.ok(second.ok, `duplicate delivery must not fail (got ${second.ok ? "ok" : second.code})`);
    assert.equal(second.sale.id, saleId, "must return the SAME sale, not a refundable error");

    const count = await client.query(
      "select count(*)::int as n from public.sales where provider_payment_id = $1",
      [paymentId],
    );
    assert.equal(count.rows[0].n, 1, "exactly one sale for one payment");
  } finally {
    winner.release();
    loser.release();
  }
});

// Regression for the refund-reconciliation downgrade race in
// src/lib/repo/supabase.ts (reconcileRefundProviderEvent). That function read
// the refund row, returned early if it was already `succeeded`, and otherwise
// ran an unguarded UPDATE. A refund.succeeded event committing between the read
// and the write was therefore overwritten back to `manual_review` by a late
// refund.failed — and an operator could then refund money that had already
// been returned. The fix is the `status <> 'succeeded'` predicate on the
// UPDATE, which Postgres re-evaluates against the latest committed row version
// when the blocked update wakes (READ COMMITTED).
//
// This test pins that exact SQL semantics with a forced interleaving, and a
// negative control proves the guard is what prevents the downgrade: without
// the predicate on a second row, the loser's write does overwrite succeeded.
test("a blocked refund failure update cannot downgrade a settled refund", { skip: !hasDocker }, async () => {
  await client.query(`
    insert into public.refunds (provider, provider_payment_id, provider_event_id, reason, status, attempts)
    values
      ('dodo', 'pi-recon-guard', 'evt-recon-guard', 'stale_quote', 'manual_review', 1),
      ('dodo', 'pi-recon-unguarded', 'evt-recon-unguarded', 'stale_quote', 'manual_review', 1)
  `);

  async function interleave(paymentId: string, guarded: boolean): Promise<number | null> {
    const winner = await client.connect();
    const loser = await client.connect();
    try {
      await winner.query("begin");
      await winner.query(
        "update public.refunds set status = 'succeeded', completed_at = now() where provider = 'dodo' and provider_payment_id = $1",
        [paymentId],
      );

      await loser.query("begin");
      const predicate = guarded ? "and status <> 'succeeded'" : "";
      let resolved = false;
      const pending = loser.query(
        `update public.refunds set status = 'manual_review', last_error = 'late failure' where provider = 'dodo' and provider_payment_id = $1 ${predicate}`,
        [paymentId],
      ).then((r) => {
        resolved = true;
        return r;
      });
      await new Promise((r) => setTimeout(r, 400)); // let it reach the row lock
      // Negative control: the winner's uncommitted update must keep this
      // statement blocked; otherwise the interleaving proves nothing.
      assert.equal(resolved, false, "loser update must still be blocked before the winner commits");
      await winner.query("commit");
      const result = await pending;
      await loser.query("commit");
      return result.rowCount;
    } finally {
      winner.release();
      loser.release();
    }
  }

  const guardedRows = await interleave("pi-recon-guard", true);
  assert.equal(guardedRows, 0, "guarded update must match zero rows after the success commits");

  const unguardedRows = await interleave("pi-recon-unguarded", false);
  assert.equal(unguardedRows, 1, "negative control: without the predicate the downgrade would land");

  const statuses = await client.query(
    "select provider_payment_id, status from public.refunds where provider = 'dodo' and provider_payment_id in ('pi-recon-guard','pi-recon-unguarded')",
  );
  const byPayment = Object.fromEntries(statuses.rows.map((r) => [r.provider_payment_id, r.status]));
  assert.equal(byPayment["pi-recon-guard"], "succeeded", "settled refund stays settled");
  assert.equal(byPayment["pi-recon-unguarded"], "manual_review", "control row shows the downgrade the guard prevents");
});

// ---------------------------------------------------------------------------
// One payment id, one outcome (migration 20260913000005). Before this, a
// refunded payment could still fund a takeover on a later event id (the
// refund branches do not all make the quote terminal), and a finalized payment
// could still be refunded by a racing claim.
test("a payment with a refund intent cannot finalize", { skip: !hasDocker }, async () => {
  const userId = await seedProfile("rpc-outcome-a");
  const paymentId = "pi-outcome-refund-first";
  await client.query(
    `insert into public.refunds (provider, provider_payment_id, provider_event_id, reason, status, attempts)
     values ('dodo', $1, 'evt-outcome-a', 'amount_mismatch', 'attempting', 1)`,
    [paymentId],
  );
  const out = await finalize({
    domain: "rpc-outcome-a.com", buyerUserId: userId, buyerHandle: "rpc-outcome-a",
    expectedVersion: 0, paidCents: 500, providerPaymentId: paymentId,
  });
  assert.ok(!out.ok);
  assert.equal(out.code, "PAYMENT_REFUNDING");
  const sales = await client.query("select count(*)::int n from public.sales where provider_payment_id = $1", [paymentId]);
  assert.equal(sales.rows[0].n, 0, "no sale may be funded by a refunding payment");
});

test("a payment that already funded a sale is not refundable", { skip: !hasDocker }, async () => {
  const userId = await seedProfile("rpc-outcome-b");
  const paymentId = "pi-outcome-sale-first";
  const sale = await finalize({
    domain: "rpc-outcome-b.com", buyerUserId: userId, buyerHandle: "rpc-outcome-b",
    expectedVersion: 0, paidCents: 500, providerPaymentId: paymentId,
  });
  assert.ok(sale.ok);

  const claim = await client.query(
    "select * from public.claim_refund_attempt($1,$2,$3,$4,$5,$6,$7)",
    ["dodo", paymentId, "evt-outcome-b", "stale_quote", 500, 3, 600],
  );
  assert.equal(claim.rows[0].claimed, false);
  assert.equal(claim.rows[0].status, "already_finalized");
  assert.match(String(claim.rows[0].last_error), /sale_exists/);
  const refunds = await client.query("select count(*)::int n from public.refunds where provider_payment_id = $1", [paymentId]);
  assert.equal(refunds.rows[0].n, 0, "no refund ledger row is created for a finalized payment");
});

// Forced interleavings over the per-payment advisory lock. Firing parallel
// requests does not reliably hit the window, so the winner's transaction is
// held open while the loser parks on the advisory lock.
test("refund-first interleaving: a blocked finalize sees the refund and refuses", { skip: !hasDocker }, async () => {
  const userId = await seedProfile("rpc-outcome-c");
  const domain = "rpc-outcome-c.com";
  const paymentId = "pi-outcome-c";
  const winner = await client.connect();
  const loser = await client.connect();
  try {
    await winner.query("begin");
    await winner.query("select * from public.claim_refund_attempt($1,$2,$3,$4,$5,$6,$7)", [
      "dodo", paymentId, "evt-outcome-c", "stale_quote", 500, 3, 600,
    ]);

    await loser.query("begin");
    let resolved = false;
    const pending: Promise<string> = loser
      .query("select * from public.finalize_takeover($1,$2,$3,$4,$5,$6)", [
        domain, userId, "rpc-outcome-c", 0, 500, paymentId,
      ])
      .then(
        () => {
          resolved = true;
          return "OK";
        },
        (e: unknown) => {
          resolved = true;
          return String(e instanceof Error ? e.message : e).split(" ")[0].replace(/["']/g, "");
        },
      );
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(resolved, false, "finalize must still be blocked on the payment advisory lock");
    await winner.query("commit");
    const code = await pending;
    await loser.query("commit").catch(() => {});
    assert.equal(code, "PAYMENT_REFUNDING");
  } finally {
    winner.release();
    loser.release();
  }
});

test("sale-first interleaving: a blocked refund claim sees the sale and refuses", { skip: !hasDocker }, async () => {
  const userId = await seedProfile("rpc-outcome-d");
  const domain = "rpc-outcome-d.com";
  const paymentId = "pi-outcome-d";
  const winner = await client.connect();
  const loser = await client.connect();
  try {
    await winner.query("begin");
    await winner.query("select * from public.finalize_takeover($1,$2,$3,$4,$5,$6)", [
      domain, userId, "rpc-outcome-d", 0, 500, paymentId,
    ]);

    await loser.query("begin");
    let resolved = false;
    const pending: Promise<string> = loser
      .query("select * from public.claim_refund_attempt($1,$2,$3,$4,$5,$6,$7)", [
        "dodo", paymentId, "evt-outcome-d", "stale_quote", 500, 3, 600,
      ])
      .then(
        (r) => {
          resolved = true;
          return String(r.rows[0].status);
        },
        (e: unknown) => {
          resolved = true;
          return `ERROR:${String(e instanceof Error ? e.message : e).split(" ")[0]}`;
        },
      );
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(resolved, false, "claim_refund_attempt must still be blocked on the advisory lock");
    await winner.query("commit");
    const status = await pending;
    await loser.query("commit").catch(() => {});
    assert.equal(status, "already_finalized");
  } finally {
    winner.release();
    loser.release();
  }
});

test("reconcile_refund_event inserts without a claim, sets the event id, and never downgrades", { skip: !hasDocker }, async () => {
  // Insert path. The function returns (status, sale_exists).
  const inserted = await client.query(
    "select * from public.reconcile_refund_event($1,$2,$3,$4,$5,$6)",
    ["dodo", "pi-recon-rpc-new", "evt-recon-rpc-new", "succeeded", 590, null],
  );
  assert.equal(inserted.rows[0].status, "succeeded");
  assert.equal(inserted.rows[0].sale_exists, false);
  const row = await client.query(
    "select status, provider_event_id, amount_cents from public.refunds where provider = 'dodo' and provider_payment_id = 'pi-recon-rpc-new'",
  );
  assert.equal(row.rows[0].status, "succeeded");
  assert.equal(row.rows[0].provider_event_id, "evt-recon-rpc-new");
  assert.equal(Number(row.rows[0].amount_cents), 590);

  // A later failure event must not downgrade the settled refund.
  const late = await client.query(
    "select * from public.reconcile_refund_event($1,$2,$3,$4,$5,$6)",
    ["dodo", "pi-recon-rpc-new", "evt-recon-rpc-late", "manual_review", null, "late failure"],
  );
  assert.equal(late.rows[0].status, "succeeded");
  const after = await client.query(
    "select status from public.refunds where provider = 'dodo' and provider_payment_id = 'pi-recon-rpc-new'",
  );
  assert.equal(after.rows[0].status, "succeeded", "settled refunds stay settled");

  // A manual_review row can be upgraded by a later success.
  await client.query(
    `insert into public.refunds (provider, provider_payment_id, provider_event_id, reason, status, attempts)
     values ('dodo', 'pi-recon-rpc-up', 'evt-up-1', 'stale_quote', 'manual_review', 1)`,
  );
  const upgraded = await client.query(
    "select * from public.reconcile_refund_event($1,$2,$3,$4,$5,$6)",
    ["dodo", "pi-recon-rpc-up", "evt-up-2", "succeeded", 590, null],
  );
  assert.equal(upgraded.rows[0].status, "succeeded");
  const upRow = await client.query(
    "select provider_event_id, amount_cents from public.refunds where provider = 'dodo' and provider_payment_id = 'pi-recon-rpc-up'",
  );
  assert.equal(upRow.rows[0].provider_event_id, "evt-up-2", "the event id is rewritten");
  assert.equal(Number(upRow.rows[0].amount_cents), 590);
});

test("reconcile_refund_event reports a sale under the same lock and never hides the contradiction", { skip: !hasDocker }, async () => {
  const userId = await seedProfile("rpc-recon-sale");
  const paymentId = "pi-recon-sale";
  const sale = await finalize({
    domain: "rpc-recon-sale.com", buyerUserId: userId, buyerHandle: "rpc-recon-sale",
    expectedVersion: 0, paidCents: 500, providerPaymentId: paymentId,
  });
  assert.ok(sale.ok);

  const reconciled = await client.query(
    "select * from public.reconcile_refund_event($1,$2,$3,$4,$5,$6)",
    ["dodo", paymentId, "evt-recon-sale", "succeeded", 500, null],
  );
  assert.equal(reconciled.rows[0].sale_exists, true, "the contradiction is detectable atomically");
  const refunds = await client.query("select count(*)::int n from public.refunds where provider_payment_id = $1", [paymentId]);
  assert.equal(refunds.rows[0].n, 1, "the provider event is recorded, never dropped");
});

// Forced interleaving: a finalize holding the payment lock while reconcile
// waits must see the committed sale in its verdict (the route used to do the
// sale lookup before reconcile, which missed exactly this window).
test("reconcile sees a sale committed while it waited on the payment lock", { skip: !hasDocker }, async () => {
  const userId = await seedProfile("rpc-recon-race");
  const paymentId = "pi-recon-race";
  const winner = await client.connect();
  const loser = await client.connect();
  try {
    await winner.query("begin");
    await winner.query("select * from public.finalize_takeover($1,$2,$3,$4,$5,$6)", [
      "rpc-recon-race.com", userId, "rpc-recon-race", 0, 500, paymentId,
    ]);

    await loser.query("begin");
    let resolved = false;
    const pending: Promise<boolean> = loser
      .query("select * from public.reconcile_refund_event($1,$2,$3,$4,$5,$6)", [
        "dodo", paymentId, "evt-recon-race", "succeeded", 500, null,
      ])
      .then(
        (r) => {
          resolved = true;
          return r.rows[0].sale_exists === true;
        },
        () => {
          resolved = true;
          return false;
        },
      );
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(resolved, false, "reconcile must still be blocked on the payment advisory lock");
    await winner.query("commit");
    const saleExists = await pending;
    await loser.query("commit").catch(() => {});
    assert.equal(saleExists, true, "the verdict must see the sale committed while parked");
  } finally {
    winner.release();
    loser.release();
  }
});

// A definitively FAILED refund (provider answered, nothing moved) must not
// park the payment forever: a later correct success event may finalize. Live
// intents (attempting/succeeded/manual_review) still block.
test("finalize is blocked by live refund intents but not by a definitively failed refund", { skip: !hasDocker }, async () => {
  const statuses: Array<{ status: string; domain: string; blocked: boolean }> = [
    { status: "attempting", domain: "rpc-live-attempting.com", blocked: true },
    { status: "manual_review", domain: "rpc-live-manual.com", blocked: true },
    { status: "succeeded", domain: "rpc-live-succeeded.com", blocked: true },
    { status: "failed", domain: "rpc-live-failed.com", blocked: false },
  ];
  for (const [i, c] of statuses.entries()) {
    const userId = await seedProfile(`rpc-live-${i}`);
    const paymentId = `pi-live-${i}`;
    await client.query(
      `insert into public.refunds (provider, provider_payment_id, provider_event_id, reason, status, attempts)
       values ('dodo', $1, $2, 'stale_quote', $3, 1)`,
      [paymentId, `evt-live-${i}`, c.status],
    );
    const out = await finalize({
      domain: c.domain, buyerUserId: userId, buyerHandle: `rpc-live-${i}`,
      expectedVersion: 0, paidCents: 500, providerPaymentId: paymentId,
    });
    if (c.blocked) {
      assert.ok(!out.ok, `${c.status} must block finalize`);
      assert.equal(out.code, "PAYMENT_REFUNDING", `${c.status} blocks with PAYMENT_REFUNDING`);
    } else {
      assert.ok(out.ok, `${c.status} must not block finalize`);
      assert.equal(Number(out.sale.price_cents), 500);
    }
  }
});
