// Operator moderation toolkit against REAL Postgres.
//
// These are the most dangerous functions in the schema: they reserve domains
// and suspend accounts. They are SECURITY DEFINER, and Postgres grants EXECUTE
// to PUBLIC by default while PostgREST exposes every public-schema function to
// anon/authenticated — so without explicit revokes, any holder of the public
// anon key could suspend users. The revokes are the whole security model, and
// a revoke nobody tests is an assumption.
//
// This toolkit also shipped for months in db/ops.sql, which NOTHING applied:
// not the migrations, not the bootstrap, not the equivalence check. DEPLOY.md
// named it as the correction procedure for legal takedowns while the functions
// existed in no database. These tests exist so that cannot recur silently.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DOCKER_IMAGE = "postgres:16-alpine";
const CONTAINER = `ipt-operator-tooling-${process.pid}-${randomUUID().slice(0, 8)}`;
let POSTGRES_URL = "";

function sh(cmd: string, ...args: string[]) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function dockerAvailable() {
  return spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8" }).status === 0;
}

async function connectPool(retries = 60) {
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

const hasDocker = dockerAvailable();
if (!hasDocker) console.warn("[operator-tooling] Docker unavailable — skipping.");

let client: pg.Pool;

test.before(async () => {
  if (!hasDocker) return;
  sh(
    "docker", "run", "-d", "--name", CONTAINER,
    "-e", "POSTGRES_USER=ipt", "-e", "POSTGRES_PASSWORD=ipt", "-e", "POSTGRES_DB=ipt",
    "-p", "0:5432", DOCKER_IMAGE,
  );
  const mapped = sh("docker", "port", CONTAINER, "5432/tcp").trim().split("\n")[0]!;
  const hostPort = mapped.slice(mapped.lastIndexOf(":") + 1);
  if (!/^\d+$/.test(hostPort)) throw new Error(`could not resolve mapped port from "${mapped}"`);
  POSTGRES_URL = `postgres://ipt:ipt@127.0.0.1:${hostPort}/ipt`;
  client = await connectPool();

  // Supabase-compat preamble, then every migration in order.
  await client.query("create role service_role nologin");
  await client.query("create role anon nologin");
  await client.query("create role authenticated nologin");
  await client.query("create schema if not exists auth");
  await client.query("create table if not exists auth.users (id uuid primary key, email text, created_at timestamptz default now())");
  await client.query("create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$");
  await client.query("create publication supabase_realtime");

  const { readdir, readFile } = await import("node:fs/promises");
  const dir = new URL("../../supabase/migrations/", import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) await client.query(await readFile(new URL(file, dir), "utf8"));
});

test.after(async () => {
  if (client) await client.end().catch(() => {});
  if (hasDocker) spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
});

const OPS = [
  "ops_reserve_domain(text, text, text)",
  "ops_unreserve_domain(text, text)",
  "ops_suspend_user(text, text)",
  "ops_unsuspend_user(text, text)",
];

test("the toolkit is actually installed by the migrations", { skip: !hasDocker }, async () => {
  const { rows } = await client.query(
    `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'ops\\_%' order by 1`,
  );
  assert.deepEqual(
    rows.map((r) => r.proname),
    ["ops_reserve_domain", "ops_suspend_user", "ops_unreserve_domain", "ops_unsuspend_user"],
    "every ops_* function must exist after a fresh migrate",
  );
  const audit = await client.query("select to_regclass('public.admin_audit') as t");
  assert.ok(audit.rows[0].t, "admin_audit must exist");
});

// The load-bearing security property.
test("anon and authenticated cannot execute any operator function", { skip: !hasDocker }, async () => {
  for (const sig of OPS) {
    for (const role of ["anon", "authenticated"]) {
      const { rows } = await client.query(
        `select has_function_privilege($1, $2, 'execute') as can`,
        [role, `public.${sig}`],
      );
      assert.equal(rows[0].can, false, `${role} must NOT execute ${sig}`);
    }
    const { rows: svc } = await client.query(
      `select has_function_privilege('service_role', $1, 'execute') as can`,
      [`public.${sig}`],
    );
    assert.equal(svc[0].can, true, `service_role must execute ${sig}`);
  }
});

test("anon and authenticated cannot read the audit trail", { skip: !hasDocker }, async () => {
  for (const role of ["anon", "authenticated"]) {
    const { rows } = await client.query(
      `select has_table_privilege($1, 'public.admin_audit', 'select') as can`,
      [role],
    );
    assert.equal(rows[0].can, false, `${role} must not read admin_audit`);
  }
});

test("reserving a domain writes the reservation and an audit row", { skip: !hasDocker }, async () => {
  const domain = `ops-${Date.now()}.com`;
  await client.query("select public.ops_reserve_domain($1, $2, $3)", [domain, "legal request", "operator"]);

  const reserved = await client.query("select reason, created_by from public.reserved_domains where domain = $1", [domain]);
  assert.equal(reserved.rowCount, 1);
  assert.equal(reserved.rows[0].reason, "legal request");

  const audit = await client.query(
    "select action, detail from public.admin_audit where target = $1 and action = 'reserve_domain'",
    [domain],
  );
  assert.equal(audit.rowCount, 1, "the privileged action must be audited");
  assert.equal(audit.rows[0].detail.by, "operator");
});

// An operator acting on a takedown must never have to care whether someone
// already did it. Before this, the plain insert raised a unique violation on
// the primary key and the whole call failed.
test("re-reserving an already-reserved domain is a no-op, not an error", { skip: !hasDocker }, async () => {
  const domain = `ops-dupe-${Date.now()}.com`;
  await client.query("select public.ops_reserve_domain($1, $2, $3)", [domain, "first", "operator"]);
  await client.query("select public.ops_reserve_domain($1, $2, $3)", [domain, "second", "operator2"]);

  const reserved = await client.query("select count(*)::int n from public.reserved_domains where domain = $1", [domain]);
  assert.equal(reserved.rows[0].n, 1, "still exactly one reservation");

  // Both attempts are still audited — the second is a real operator action
  // even though it changed nothing.
  const audit = await client.query("select count(*)::int n from public.admin_audit where target = $1", [domain]);
  assert.equal(audit.rows[0].n, 2, "both attempts recorded");
});

test("suspend and unsuspend flip the profile and are audited", { skip: !hasDocker }, async () => {
  const id = randomUUID();
  const handle = `opsuser${Date.now().toString(36)}`;
  await client.query("insert into auth.users(id) values ($1)", [id]);
  await client.query("insert into public.profiles(id, handle) values ($1, $2)", [id, handle]);

  await client.query("select public.ops_suspend_user($1, $2)", [handle, "operator"]);
  let p = await client.query("select suspended_at from public.profiles where handle = $1", [handle]);
  assert.ok(p.rows[0].suspended_at, "suspension must be set");

  await client.query("select public.ops_unsuspend_user($1, $2)", [handle, "operator"]);
  p = await client.query("select suspended_at from public.profiles where handle = $1", [handle]);
  assert.equal(p.rows[0].suspended_at, null, "unsuspend must clear it");

  const audit = await client.query("select count(*)::int n from public.admin_audit where target = $1", [handle]);
  assert.equal(audit.rows[0].n, 2);
});

test("unreserving removes the row and audits it", { skip: !hasDocker }, async () => {
  const domain = `ops-un-${Date.now()}.com`;
  await client.query("select public.ops_reserve_domain($1, $2, $3)", [domain, "mistake", "operator"]);
  await client.query("select public.ops_unreserve_domain($1, $2)", [domain, "operator"]);
  const reserved = await client.query("select count(*)::int n from public.reserved_domains where domain = $1", [domain]);
  assert.equal(reserved.rows[0].n, 0);
  const audit = await client.query(
    "select count(*)::int n from public.admin_audit where target = $1 and action = 'unreserve_domain'",
    [domain],
  );
  assert.equal(audit.rows[0].n, 1);
});
