// Pricing parity harness: the LOCKED market formula is implemented twice in
// executable code — once in TypeScript (src/lib/game.ts quoteFor, which the
// quote endpoint, the checkout amount check and the in-memory repo adapter all
// use) and once in SQL (finalize_takeover, which is what actually moves money
// in production). Nothing previously asserted the two agree, so a divergence
// would only surface as a live customer paying an amount the RPC rejects — or
// worse, accepts.
//
// This walks a price ladder that includes every interesting boundary of
// `increment = max($5, ceil(1% of price))` and asserts the SQL required price
// and quoteFor().nextPriceCents are byte-identical at each rung, then proves
// the SQL accepts EXACTLY that amount (required ± 1 cent is rejected).
//
// Same shape as tests/pg/finalize-rpc.test.ts: a disposable postgres:16-alpine
// container with the real supabase/migrations applied, skipping cleanly (exit
// 0) when Docker is unavailable so CI stays green.
//
// Usage: node --experimental-strip-types tests/pg/pricing-parity.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { quoteFor, type DomainRecord } from "../../src/lib/game.ts";

const DOCKER_IMAGE = "postgres:16-alpine";
// Unique per run, host port assigned by Docker. A fixed name + port made two
// concurrent runs kill each other's database (the pre-boot `docker rm -f` hits
// the shared name), failing every test at once and looking exactly like a
// money-path regression. See the same note in finalize-rpc.test.ts.
const CONTAINER = `ipt-pricing-parity-test-${process.pid}-${randomUUID().slice(0, 8)}`;
let POSTGRES_URL = "";

function sh(cmd: string, ...args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function dockerAvailable() {
  const r = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8" });
  return r.status === 0;
}

async function connectPool(retries = 30): Promise<pg.Pool> {
  for (let i = 0; i < retries; i++) {
    try {
      const pool = new pg.Pool({ connectionString: POSTGRES_URL, max: 5 });
      await pool.query("select 1");
      return pool;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("postgres did not become ready in time");
}

async function runMigrations(client: pg.Client | pg.Pool): Promise<void> {
  const { readFile, readdir } = await import("node:fs/promises");

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

  // Every migration, in filename order — not a hardcoded subset. A parity test
  // that applied a stale list would certify a finalize_takeover production no
  // longer runs (later migrations redefine the function).
  const dir = new URL("../../supabase/migrations/", import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = await readFile(new URL(file, dir), "utf8");
    await client.query(sql);
  }
}

const hasDocker = dockerAvailable();
if (!hasDocker) {
  console.warn("[pricing-parity] Docker not available — skipping SQL/TS pricing parity tests.");
}

let client: pg.Pool;

test.before(async () => {
  if (!hasDocker) return;
  sh(
    "docker", "run", "-d", "--name", CONTAINER,
    "-e", "POSTGRES_USER=ipt", "-e", "POSTGRES_PASSWORD=ipt", "-e", "POSTGRES_DB=ipt",
    "-p", "0:5432", // Docker picks a free host port — no port races
    "--health-cmd", "pg_isready -U ipt", "--health-interval=1s", "--health-timeout=1s", "--health-retries=15",
    DOCKER_IMAGE,
  );
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
let seq = 0;
function nextId() {
  seq += 1;
  return seq;
}

async function seedProfile(handle: string): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`,
    [id, `${handle}@parity-test.local`],
  );
  await client.query(`insert into public.profiles (id, handle) values ($1, $2)`, [id, handle]);
  return id;
}

type FinalizeArgs = {
  domain: string;
  buyerUserId: string;
  buyerHandle: string;
  expectedVersion: number;
  paidCents: number;
  providerPaymentId: string;
};
type FinalizeResult =
  | { ok: true; sale: Record<string, string> }
  | { ok: false; message: string; code: string };

/** Failure detail for assertion messages without losing union narrowing. */
function detail(r: FinalizeResult): string {
  return r.ok ? "ok" : r.message;
}

async function finalize(args: FinalizeArgs): Promise<FinalizeResult> {
  try {
    const res = await client.query("select * from public.finalize_takeover($1,$2,$3,$4,$5,$6)", [
      args.domain, args.buyerUserId, args.buyerHandle, args.expectedVersion,
      args.paidCents, args.providerPaymentId,
    ]);
    return { ok: true, sale: res.rows[0] };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, message, code: message.split(" ")[0].replace(/["']/g, "") };
  }
}

/**
 * Reads the price the SQL function itself demands, straight out of its
 * WRONG_PRICE diagnostic ("WRONG_PRICE expected N, got M (minimum)"). Probing beats
 * re-implementing the SQL arithmetic in the test, which would just be a fifth
 * copy of the formula.
 */
async function sqlRequiredPrice(domain: string, expectedVersion: number, probeBuyerId: string, probeHandle: string): Promise<number> {
  const out = await finalize({
    domain, buyerUserId: probeBuyerId, buyerHandle: probeHandle,
    expectedVersion, paidCents: 1, providerPaymentId: `pi-probe-${randomUUID()}`,
  });
  assert.ok(!out.ok, `probe payment of 1 cent must be rejected on ${domain}`);
  assert.equal(out.code, "WRONG_PRICE", `unexpected probe failure on ${domain}: ${out.message}`);
  const m = /expected (\d+)/.exec(out.message);
  assert.ok(m, `WRONG_PRICE did not report the required price: ${out.message}`);
  return Number(m[1]);
}

/** Live market row in the shape game.ts reasons about. */
async function liveRecord(domain: string): Promise<DomainRecord> {
  const res = await client.query("select * from public.domains where domain = $1", [domain]);
  const row = res.rows[0];
  if (!row) return { domain, holder: null, priceCents: 0, version: 0, history: [] };
  return {
    domain,
    holder: row.holder_handle,
    priceCents: Number(row.price_cents),
    version: Number(row.version),
    history: [],
  };
}

/** Puts a domain into a chosen held state so the ladder can hit exact boundaries. */
async function seedDomainAt(domain: string, priceCents: number): Promise<void> {
  if (priceCents === 0) return; // unclaimed: finalize_takeover materializes the row
  const handle = `parity-holder-${nextId()}`;
  const holderId = await seedProfile(handle);
  await client.query(
    `insert into public.domains (domain, holder_user_id, holder_handle, price_cents, version, claimed_at, updated_at)
     values ($1, $2, $3, $4, 1, now(), now())`,
    [domain, holderId, handle, priceCents],
  );
}

// ------------------------------------------------------------------- tests

// Boundaries that matter: unclaimed; the $5 floor; either side of $500 where
// the 1% term overtakes the $5 minimum; a price whose 1% has a fractional cent
// (must round UP); and large prices where 1% dominates entirely.
const LADDER = [
  { label: "unclaimed", priceCents: 0 },
  { label: "$5.00 floor", priceCents: 500 },
  { label: "$499 (1% still below the $5 minimum)", priceCents: 49_900 },
  { label: "$500 (1% exactly equals the $5 minimum)", priceCents: 50_000 },
  { label: "$501 (1% overtakes the minimum)", priceCents: 50_100 },
  { label: "$500.01 (fractional cent must round up)", priceCents: 50_001 },
  { label: "$500.99 (fractional cent must round up)", priceCents: 50_099 },
  { label: "$999.99", priceCents: 99_999 },
  { label: "$12,345.67", priceCents: 1_234_567 },
  { label: "$9,876,543.21", priceCents: 987_654_321 },
];

test("SQL finalize_takeover and TS quoteFor agree at every ladder boundary", { skip: !hasDocker }, async () => {
  for (const rung of LADDER) {
    const domain = `parity-${nextId()}.com`;
    await seedDomainAt(domain, rung.priceCents);

    const record = await liveRecord(domain);
    assert.equal(record.priceCents, rung.priceCents, `${rung.label}: seed mismatch`);

    const buyerHandle = `parity-buyer-${nextId()}`;
    const buyerId = await seedProfile(buyerHandle);

    const sqlPrice = await sqlRequiredPrice(domain, record.version, buyerId, buyerHandle);
    const tsQuote = quoteFor(record);
    assert.equal(
      sqlPrice, tsQuote.nextPriceCents,
      `${rung.label}: SQL wants ${sqlPrice}, quoteFor() wants ${tsQuote.nextPriceCents}`,
    );

    // Below the floor is rejected. A higher amount is intentionally valid and
    // is covered by the dedicated high-offer SQL test.
    const below = await finalize({
      domain, buyerUserId: buyerId, buyerHandle,
      expectedVersion: record.version, paidCents: sqlPrice - 1,
      providerPaymentId: `pi-below-${randomUUID()}`,
    });
    assert.ok(!below.ok && below.code === "WRONG_PRICE", `${rung.label}: ${sqlPrice - 1} should be WRONG_PRICE`);

    const paid = await finalize({
      domain, buyerUserId: buyerId, buyerHandle,
      expectedVersion: record.version, paidCents: tsQuote.nextPriceCents,
      providerPaymentId: `pi-parity-${randomUUID()}`,
    });
    assert.ok(paid.ok, `${rung.label}: quoteFor price was rejected by SQL: ${detail(paid)}`);
    assert.equal(Number(paid.sale.price_cents), tsQuote.nextPriceCents);

    const after = await liveRecord(domain);
    assert.equal(after.priceCents, tsQuote.nextPriceCents, `${rung.label}: market price did not settle at the quoted price`);
    assert.equal(after.version, record.version + 1);
  }
});

test("SQL and TS stay in lockstep across a compounding takeover ladder", { skip: !hasDocker }, async () => {
  // Every rung above is a synthetic seed; this one compounds for real, so a
  // rounding drift would accumulate instead of being reset each iteration.
  const domain = `parity-walk-${nextId()}.com`;
  const seen: number[] = [];

  for (let step = 0; step < 12; step += 1) {
    const record = await liveRecord(domain);
    const buyerHandle = `parity-walker-${nextId()}`;
    const buyerId = await seedProfile(buyerHandle);

    const sqlPrice = await sqlRequiredPrice(domain, record.version, buyerId, buyerHandle);
    const tsQuote = quoteFor(record);
    assert.equal(
      sqlPrice, tsQuote.nextPriceCents,
      `step ${step} at ${record.priceCents}: SQL ${sqlPrice} vs quoteFor ${tsQuote.nextPriceCents}`,
    );

    const paid = await finalize({
      domain, buyerUserId: buyerId, buyerHandle,
      expectedVersion: record.version, paidCents: tsQuote.nextPriceCents,
      providerPaymentId: `pi-walk-${step}-${randomUUID()}`,
    });
    assert.ok(paid.ok, `step ${step}: ${detail(paid)}`);
    seen.push(tsQuote.nextPriceCents);
  }

  // Sanity on the locked formula itself: the first claim is $5.00 and every
  // later step adds at least the $5 minimum increment.
  assert.equal(seen[0], 500);
  for (let i = 1; i < seen.length; i += 1) {
    assert.ok(seen[i] - seen[i - 1] >= 500, `step ${i} increment fell below the $5 minimum`);
  }
});
