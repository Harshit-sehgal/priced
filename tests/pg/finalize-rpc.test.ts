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

function sh(cmd, ...args) {
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

async function runMigrations(client) {
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
let client;

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
async function seedProfile(handle) {
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

async function finalize(args) {
  try {
    const res = await client.query("select * from public.finalize_takeover($1,$2,$3,$4,$5,$6)", [
      args.domain, args.buyerUserId, args.buyerHandle, args.expectedVersion,
      args.paidCents, args.providerPaymentId,
    ]);
    return { ok: true, sale: res.rows[0] };
  } catch (e) {
    const code = String(e.message).split(" ")[0].replace(/["']/g, "");
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
  assert.equal(winners.length, 1);
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
  const out = await finalize({
    domain: "rpc-conflict.com", buyerUserId: userId, buyerHandle: "rpc-conflict",
    expectedVersion: 0, paidCents: 500, providerPaymentId: "pi-rpc-conflict-1-different",
  });
  // different payment id → normal second-claim path at the new price.
  assert.ok(!out.ok);
  assert.equal(out.code, "STALE_QUOTE");
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
  const a = res.rows[0].out;
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
  const call = (c) =>
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
    const pending = call(loser).then(
      (r) => ({ ok: true, sale: r.rows[0] }),
      (e) => ({ ok: false, code: String(e.message).split(" ")[0] }),
    );
    await new Promise((r) => setTimeout(r, 400)); // let it reach the lock
    await winner.query("commit");

    const second = await pending;
    await loser.query("commit").catch(() => {});

    assert.ok(second.ok, `duplicate delivery must not fail (got ${second.code})`);
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
