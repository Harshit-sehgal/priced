# Migrations

`db/schema.sql` + `db/schema-extended.sql` + `db/ops.sql` are the portable
single-apply SQL for any Postgres (handy for a quick local/Supabase SQL Editor
bootstrap). `ops.sql` carries the operator moderation toolkit; leaving it out
leaves the documented takedown/suspension procedure without its functions.

`supabase/migrations/*.sql` is the **canonical ordered history** — versioned,
deterministic, and safe to apply incrementally with `supabase db push` or
`psql`. A brand-new database should be creatable by applying these files in
lexicographic order.

## Running

```bash
# Supabase CLI (recommended when a project is linked)
npx supabase db push
# EXCEPTION: do NOT run db push against the EXISTING hosted Priced project.
# Its migration history predates the canonical filenames (early applies were
# recorded under other versions), so db push refuses and a blind repair would
# replay every migration. Apply new files individually:
#   npx supabase db query --linked --file supabase/migrations/<new>.sql
# DEPLOY.md §1 has the full procedure.

# Or plain psql (works against any hosted Postgres)
for f in supabase/migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done

# Legacy single-apply (still supported, e.g. fresh SQL Editor paste)
psql "$DATABASE_URL" -f db/schema.sql
psql "$DATABASE_URL" -f db/schema-extended.sql
psql "$DATABASE_URL" -f db/ops.sql
```

`db/migration-quotes-checkout.sql` is a historical patch for databases created
before the `checkout_*` quote columns existed; fresh bootstraps already include
those columns and do not need it.

## Adding a new migration

1. Copy the next `supabase/migrations/AAAAMMDDHHMMSS_description.sql` name.
2. Make every statement idempotent (`if not exists`, `add column if not exists`,
   wrapped `alter publication … add table` in `DO $$ exception when duplicate_object`).
3. Mirror any schema change back into `db/schema.sql` or `db/schema-extended.sql`
   so the portable files stay equivalent.
4. Test against a throwaway DB — CI checks that a fresh DB boots from migrations.

## Ownership

Migrations are append-only. Never rewrite a past file; add a new one instead.
Sales remain append-only too — the product is a ledger.
