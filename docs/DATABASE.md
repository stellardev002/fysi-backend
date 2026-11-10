# Database: Postgres on Railway

Fysi runs on plain **PostgreSQL** (Railway's Postgres service in production; any Postgres 15+ works, e.g. Docker for local tests). Authentication is the backend's own (see ARCHITECTURE.md). The ORM is **Drizzle**; the schema lives in `src/database/schema/` and SQL migrations in `drizzle/`.

## Connection strings

| Where | URL | Use |
| --- | --- | --- |
| Inside Railway | `${{Postgres.DATABASE_URL}}` (host `postgres.railway.internal`) | `DATABASE_URL` on the API service |
| From your laptop | Postgres service → **Connect** → *Public network* (`DATABASE_PUBLIC_URL`) | `pnpm db:migrate`, `pnpm admin:create`, `pg_dump` |

The app needs a **direct (session) connection**: the migrator, the payment watcher and settlement signing hold Postgres advisory locks across several statements. Railway's Postgres is a plain server, so this holds. If you ever put a pooler in front (PgBouncer in transaction mode, Neon's `-pooler` host, Supabase's port 6543), point the app at the direct connection instead.

`DATABASE_MIGRATION_URL` is optional and falls back to `DATABASE_URL`. `DB_POOL_MAX=5` is plenty for one API instance.

If the password contains `@ : / ? # %` or spaces, URL-encode it in the connection string (e.g. `@` → `%40`).

## Local and test databases

```bash
docker run -d --name fysi-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=fysi -p 55432:5432 postgres:17
```

Use `postgres://postgres:postgres@localhost:55432/fysi` as `DATABASE_URL`. The e2e tests need their **own** disposable database (they create throwaway accounts); never point them at production.

## Applying migrations

```bash
pnpm build
pnpm db:migrate        # reads DATABASE_URL (or DATABASE_MIGRATION_URL) from .env
```

On Railway this happens automatically: the container runs `node dist/database/migrate.js` before starting the API, and a failed migration stops the deploy. Concurrent boots wait on a Postgres advisory lock, so two instances never migrate at once. Applied migrations are recorded in the `drizzle.__drizzle_migrations` table.

| Migration | What it does |
| --- | --- |
| `0000_init` | Users (roles customer, vendor, admin, super admin; phone; encrypted TOTP secret), OTP codes, refresh tokens (with the 2FA flag), suspensions, audit log, categories, vendors (business, KYB, encrypted director NIN/BVN, verification status), vendor documents, products (prices in US cents, stock, certifications, moderation, generated full-text search vector), product images, cart items; wallets (custodial and settlement, custody handle, KYC tier, PIN hash), orders, vendor orders (fulfilment and escrow status, commission), order lines, payments (one row per ledger operation, unique), payouts, refunds, withdrawals, the watcher cursor; RLS on every table |
| `0001_hardening_and_seed` | Append-only trigger on the audit log, Supabase browser-role lockdown, the six launch categories |

## Security model: why RLS is on everywhere

Supabase publishes the `public` schema through its Data API to the `anon` and `authenticated` roles, and the anon key ships inside browsers. Without protection, anyone could read `users` (including password hashes) straight from Supabase. So:

- every table has row-level security **enabled with no policies**, which denies those roles every row;
- those roles have no table, sequence or function privileges, including on tables created later (default privileges revoked);
- the backend connects as the table owner (`postgres`), which RLS does not apply to.

This was verified against Postgres 17 with Supabase-style roles: the backend reads normally; `anon` and `authenticated` get `permission denied`, even on tables created after the migration. `test/database.e2e-spec.ts` fails if any public table lacks RLS or grants anything to those roles.

**Rule for new tables:** end every `pgTable(...)` with `.enableRLS()`. `pnpm db:generate` then emits the `ENABLE ROW LEVEL SECURITY` statement.

## Changing the schema

1. Edit or add a file in `src/database/schema/` (add new files to `schema/index.ts`; finish the table with `.enableRLS()`).
2. `pnpm db:generate` → review the new SQL in `drizzle/`.
3. `pnpm build && pnpm db:migrate` locally, then run `pnpm test:e2e` against the test project.
4. Commit the schema change and the migration together. Railway applies it on the next deploy.

Destructive changes (dropping or renaming columns/tables) need explicit sign-off and a backup first.

## Backups

Before any risky migration, take a dump with the Postgres client tools (`pg_dump`, any version ≥ the server's):

```bash
pg_dump "<DATABASE_PUBLIC_URL>" --format=custom --no-owner --file=fysi-$(date +%F).dump
```

Turn on Railway's Postgres backups (service → Backups, plan-dependent); don't rely on them as the only copy.

## Moving data from another Postgres

To copy data in from another Postgres (e.g. an earlier Supabase or Neon database) without touching the source:

1. Run the migrations on the **empty** target (`pnpm db:migrate`), so the schema, triggers and RLS come from this repo.
2. Dump **data only** from the source, read-only, skipping Drizzle's own bookkeeping:
   ```bash
   pg_dump "<source URI>" --data-only --no-owner --no-privileges \
     --exclude-schema=drizzle --format=custom --file=source-data.dump
   ```
3. Restore into the target:
   ```bash
   pg_restore --data-only --no-owner --dbname="<DATABASE_PUBLIC_URL>" source-data.dump
   ```
   Foreign keys have no cycles, so parents load before children. The audit-log trigger only blocks updates and deletes, so inserts load fine.
4. Compare row counts table by table, then deploy.

## Notes

- Every table has row-level security enabled with no policies. On Railway nothing uses it (the app connects as the table owner, which RLS does not apply to); it is kept so the schema stays safe on hosts that expose Postgres to browsers (Supabase's Data API). `test/database.e2e-spec.ts` checks it.
- Migration `0001` revokes Supabase's browser roles when they exist and skips that step elsewhere.
