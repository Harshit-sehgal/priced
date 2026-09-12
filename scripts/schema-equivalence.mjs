#!/usr/bin/env node
// Prove that the two SQL sources actually agree.
//
// The repo keeps schema in two places on purpose (see
// supabase/migrations/README.md): `supabase/migrations/*.sql` is the canonical
// ordered history, and `db/schema.sql` + `db/schema-extended.sql` are portable
// single-apply equivalents so a fresh project can be bootstrapped without the
// Supabase CLI. Keeping them in sync was a MANUAL promise, and CI only checked
// that the files existed and contained a couple of greps — which cannot catch
// drift in a function BODY. That matters here because `finalize_takeover` is
// the money path: the two copies silently disagreeing is a live financial bug.
//
// This script boots two disposable Postgres containers, applies one source to
// each, then diffs the resulting schema — table columns, constraints, indexes
// and, critically, every function definition.
//
// Exits 0 when equivalent, 1 on drift, and 0 with a SKIP notice when Docker is
// unavailable so CI stays green on runners without it.
import { execFileSync, spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";

const IMAGE = "postgres:16-alpine";
// Unique per run with Docker-assigned host ports. Fixed names/ports let two
// concurrent runs (CI job + a developer, or two CI jobs) delete each other's
// database mid-check and report drift that does not exist.
const RUN_ID = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
const TARGETS = [
  { name: "migrations", container: `ipt-equiv-migrations-${RUN_ID}`, port: 0 },
  { name: "portable-db", container: `ipt-equiv-portable-${RUN_ID}`, port: 0 },
];

function dockerAvailable() {
  return spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8" }).status === 0;
}

function sh(cmd, ...args) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function boot(target) {
  sh(
    "docker", "run", "-d", "--name", target.container,
    "-e", "POSTGRES_USER=ipt", "-e", "POSTGRES_PASSWORD=ipt", "-e", "POSTGRES_DB=ipt",
    "-p", "0:5432", IMAGE,
  );
  const mapped = sh("docker", "port", target.container, "5432/tcp").trim().split("\n")[0];
  const hostPort = mapped.slice(mapped.lastIndexOf(":") + 1);
  if (!/^\d+$/.test(hostPort)) throw new Error(`could not resolve mapped port from "${mapped}"`);
  target.port = Number(hostPort);
}

async function connect(port, retries = 60) {
  for (let i = 0; i < retries; i++) {
    try {
      const pool = new pg.Pool({ connectionString: `postgres://ipt:ipt@127.0.0.1:${port}/ipt`, max: 4 });
      await pool.query("select 1");
      return pool;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`postgres on ${port} never became ready`);
}

// Supabase-specific objects the SQL references but plain Postgres lacks.
async function preamble(pool) {
  await pool.query("create role service_role nologin");
  await pool.query("create role anon nologin");
  await pool.query("create role authenticated nologin");
  await pool.query("create schema if not exists auth");
  await pool.query("create table if not exists auth.users (id uuid primary key, email text, created_at timestamptz default now())");
  await pool.query("create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$");
  await pool.query("create publication supabase_realtime");
}

async function applyMigrations(pool) {
  const dir = new URL("../supabase/migrations/", import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) await pool.query(await readFile(new URL(f, dir), "utf8"));
  return files.length;
}

async function applyPortable(pool) {
  // ops.sql is part of the bootstrap, not an optional extra: DEPLOY.md names
  // it as the operator correction procedure. It was previously outside this
  // check, which is exactly why admin_audit and every ops_* function silently
  // existed in no database at all.
  const files = ["schema.sql", "schema-extended.sql", "ops.sql"];
  for (const f of files) {
    await pool.query(await readFile(new URL(`../db/${f}`, import.meta.url), "utf8"));
  }
  return files.length;
}

// --- schema fingerprints -----------------------------------------------------
const COLUMNS_SQL = `
  select table_name, column_name, data_type, is_nullable, column_default
  from information_schema.columns
  where table_schema = 'public'
  order by table_name, column_name`;

const CONSTRAINTS_SQL = `
  select c.conrelid::regclass::text as tbl, c.conname, pg_get_constraintdef(c.oid) as def
  from pg_constraint c
  join pg_namespace n on n.oid = c.connamespace
  where n.nspname = 'public'
  order by 1, 2, 3`;

const INDEXES_SQL = `
  select tablename, indexname, indexdef
  from pg_indexes where schemaname = 'public'
  order by 1, 2`;

const FUNCTIONS_SQL = `
  select p.proname, pg_get_functiondef(p.oid) as def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
  order by 1, 2`;

// Structure alone is not enough. The whole point of the hardening migrations is
// WHO may do WHAT: finalize_takeover and holder_analytics must be service_role
// only, analytics_events/payment_events must be unreadable by anon, and
// profiles.suspended_at must not be selectable by clients. Two schemas can have
// identical tables and still differ on every one of those, so privileges, RLS
// flags, policies and realtime publication membership are all fingerprinted.
const TABLE_ACL_SQL = `
  select table_name, grantee, privilege_type
  from information_schema.table_privileges
  where table_schema = 'public' and grantee in ('anon','authenticated','service_role','PUBLIC')
  order by 1, 2, 3`;

const COLUMN_ACL_SQL = `
  select table_name, column_name, grantee, privilege_type
  from information_schema.column_privileges
  where table_schema = 'public' and grantee in ('anon','authenticated','service_role','PUBLIC')
  order by 1, 2, 3, 4`;

const FUNCTION_ACL_SQL = `
  select p.proname, r.rolname, has_function_privilege(r.rolname, p.oid, 'execute') as can_execute
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join (select rolname from pg_roles where rolname in ('anon','authenticated','service_role')) r
  where n.nspname = 'public'
  order by 1, 2`;

const RLS_SQL = `
  select c.relname, c.relrowsecurity, c.relforcerowsecurity
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
  order by 1`;

const POLICY_SQL = `
  select tablename, policyname, permissive, roles::text, cmd,
         coalesce(qual, '') as qual, coalesce(with_check, '') as with_check
  from pg_policies where schemaname = 'public'
  order by 1, 2`;

const PUBLICATION_SQL = `
  select pubname, schemaname, tablename
  from pg_publication_tables order by 1, 2, 3`;

async function fingerprint(pool) {
  const [cols, cons, idx, fns, tacl, cacl, facl, rls, pol, pub] = await Promise.all([
    pool.query(COLUMNS_SQL), pool.query(CONSTRAINTS_SQL),
    pool.query(INDEXES_SQL), pool.query(FUNCTIONS_SQL),
    pool.query(TABLE_ACL_SQL), pool.query(COLUMN_ACL_SQL), pool.query(FUNCTION_ACL_SQL),
    pool.query(RLS_SQL), pool.query(POLICY_SQL), pool.query(PUBLICATION_SQL),
  ]);
  return {
    columns: cols.rows.map((r) => `${r.table_name}.${r.column_name} ${r.data_type} null=${r.is_nullable} default=${r.column_default ?? ""}`),
    constraints: cons.rows.map((r) => `${r.tbl} ${r.conname} ${r.def}`),
    indexes: idx.rows.map((r) => `${r.tablename} ${r.indexname} ${r.indexdef}`),
    // Normalise whitespace: formatting differences between the two files are
    // not drift, but a changed statement inside a body absolutely is.
    functions: fns.rows.map((r) => `${r.proname} :: ${r.def.replace(/\s+/g, " ").trim()}`),
    "table grants": tacl.rows.map((r) => `${r.table_name} ${r.grantee} ${r.privilege_type}`),
    "column grants": cacl.rows.map((r) => `${r.table_name}.${r.column_name} ${r.grantee} ${r.privilege_type}`),
    "function grants": facl.rows.map((r) => `${r.proname} ${r.rolname} execute=${r.can_execute}`),
    "row level security": rls.rows.map((r) => `${r.relname} rls=${r.relrowsecurity} forced=${r.relforcerowsecurity}`),
    policies: pol.rows.map((r) => `${r.tablename} ${r.policyname} ${r.permissive} ${r.roles} ${r.cmd} using=${r.qual.replace(/\s+/g, " ")} check=${r.with_check.replace(/\s+/g, " ")}`),
    "realtime publication": pub.rows.map((r) => `${r.pubname} ${r.schemaname}.${r.tablename}`),
  };
}

function diffSection(label, a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  const onlyMigrations = a.filter((x) => !setB.has(x));
  const onlyPortable = b.filter((x) => !setA.has(x));
  if (onlyMigrations.length === 0 && onlyPortable.length === 0) {
    console.log(`  ok  ${label}: ${a.length} identical`);
    return 0;
  }
  console.log(`  DRIFT ${label}:`);
  for (const x of onlyMigrations) console.log(`    only in supabase/migrations: ${x.slice(0, 240)}`);
  for (const x of onlyPortable) console.log(`    only in db/*.sql          : ${x.slice(0, 240)}`);
  return onlyMigrations.length + onlyPortable.length;
}

async function main() {
  if (!dockerAvailable()) {
    console.log("SKIP: Docker unavailable — schema equivalence not checked.");
    return 0;
  }
  const pools = [];
  try {
    for (const t of TARGETS) boot(t);
    const [mPool, pPool] = await Promise.all(TARGETS.map((t) => connect(t.port)));
    pools.push(mPool, pPool);
    await Promise.all([preamble(mPool), preamble(pPool)]);

    const nMig = await applyMigrations(mPool);
    const nPort = await applyPortable(pPool);
    console.log(`applied ${nMig} migration(s) and ${nPort} portable file(s)\n`);

    const [fm, fp] = await Promise.all([fingerprint(mPool), fingerprint(pPool)]);
    let drift = 0;
    for (const key of Object.keys(fm)) {
      drift += diffSection(key, fm[key], fp[key]);
    }
    if (drift > 0) {
      console.log(`\nFAIL: ${drift} difference(s). db/*.sql and supabase/migrations/ have drifted.`);
      console.log("Mirror the change into BOTH sources (see supabase/migrations/README.md).");
      return 1;
    }
    console.log("\nPASS: db/*.sql is equivalent to supabase/migrations/.");
    return 0;
  } finally {
    for (const p of pools) await p.end().catch(() => {});
    for (const t of TARGETS) spawnSync("docker", ["rm", "-f", t.container], { stdio: "ignore" });
  }
}

process.exit(await main());
