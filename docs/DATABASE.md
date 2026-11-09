# Database: Supabase Postgres

Fysi uses **Supabase as a Postgres host** and Supabase Storage (over S3) for files. Authentication is the backend's own (see ARCHITECTURE.md); Supabase Auth and the Data API are not used. The ORM is **Drizzle**; the schema lives in `src/database/schema/` and SQL migrations in `drizzle/`.

## Connection strings

Supabase offers three ways in. Only one fits this backend on Render:

| Option | Host:port | Works from Render? | Use |
| --- | --- | --- | --- |
| Direct connection | `db.<ref>.supabase.co:5432` | **No.** IPv6 only on the free plan; Render has no outbound IPv6 | — |
| **Session pooler** | `aws-<n>-<region>.pooler.supabase.com:5432` | **Yes (IPv4)** | `DATABASE_URL` (runtime and migrations) |
| Transaction pooler | `aws-<n>-<region>.pooler.supabase.com:6543` | Yes | **Not used**: it breaks session-level advisory locks, which the migrator and background jobs rely on |

`DATABASE_MIGRATION_URL` is optional and falls back to `DATABASE_URL`. Set it only if you later use a different route for migrations (e.g. the direct connection with Supabase's paid IPv4 add-on).

The session pooler caps client connections on the free plan, so `DB_POOL_MAX=5`. Raise it only together with the Supabase compute size.

If the database password contains `@ : / ? # %` or spaces, URL-encode it in the connection string (e.g. `@` → `%40`), or pick a password of letters and digits.

## Setting up Supabase

1. Sign in at **supabase.com** → **New project**.
   - Name: `fysi`. Database password: generate a strong one and save it in a password manager.
   - Region: the one closest to your users and to the Render region (`render.yaml` uses Frankfurt → choose **Central EU (Frankfurt)**).
2. When the project is ready, click **Connect** (top bar) → **Session pooler**. Copy the URI and replace `[YOUR-PASSWORD]` with the database password. This is `DATABASE_URL`.
3. Optional hardening: the backend never uses Supabase's Data API (the auto-generated REST endpoints). Turn it off in the dashboard's Data API settings if your dashboard offers the switch. The migrations already lock it down either way (below).
4. For the e2e tests, create a **second** free project (e.g. `fysi-test`) and use its session pooler URI. Never run tests against the real project: they create throwaway accounts.

Free-plan notes: projects **pause after 7 days without activity** (unpause from the dashboard; data is kept), and there is a limit of two active free projects.

## Applying migrations

```bash
pnpm build
pnpm db:migrate        # reads DATABASE_URL (or DATABASE_MIGRATION_URL) from .env
```

On Render this happens automatically: the container runs `node dist/database/migrate.js` before starting the API, and a failed migration stops the deploy. Concurrent boots wait on a Postgres advisory lock, so two instances never migrate at once. Applied migrations are recorded in the `drizzle.__drizzle_migrations` table.

| Migration | What it does |
| --- | --- |
| `0000_init` | Users (roles customer, vendor, admin, super admin; phone; encrypted TOTP secret), OTP codes, refresh tokens (with the 2FA flag), suspensions, audit log, categories, vendors (business, KYB, encrypted director NIN/BVN, verification status), vendor documents, products (prices in US cents, stock, certifications, moderation, generated full-text search vector), product images, cart items; RLS on every table |
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
4. Commit the schema change and the migration together. Render applies it on the next deploy.

Destructive changes (dropping or renaming columns/tables) need explicit sign-off and a backup first.

## Backups

Before any risky migration, take a dump with the Postgres client tools (`pg_dump`, any version ≥ the server's):

```bash
pg_dump "<session pooler URI>" --format=custom --no-owner --file=fysi-$(date +%F).dump
```

Check your Supabase plan's backup policy in the dashboard; don't rely on it as the only copy.

## Moving data from another Postgres (e.g. Neon)

If you ever need to copy data into Supabase from another Postgres, without touching the source:

1. Run the migrations on the **empty** Supabase database (`pnpm db:migrate`), so the schema, triggers and RLS come from this repo.
2. Dump **data only** from the source, read-only, skipping Drizzle's own bookkeeping:
   ```bash
   pg_dump "<source URI>" --data-only --no-owner --no-privileges \
     --exclude-schema=drizzle --format=custom --file=source-data.dump
   ```
3. Restore into Supabase:
   ```bash
   pg_restore --data-only --no-owner \
     --dbname="<supabase session pooler URI>" source-data.dump
   ```
   pg_restore loads parent tables before children because the foreign keys have no cycles. Don't add `--disable-triggers`: it needs superuser, which Supabase's `postgres` role is not. The audit-log trigger only blocks updates and deletes, so inserts load fine.
4. Compare row counts table by table between source and target, then point `DATABASE_URL` at Supabase.

The source database is only read, never changed.
