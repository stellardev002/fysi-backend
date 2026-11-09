# fysi-backend

API for **Fysi**, a marketplace for certified eco-friendly products with payments settled in USDC on Stellar. Verified vendors sign up and sell; customers browse and keep a cart without an account, then sign up to buy; admins verify vendors and moderate the catalogue.

NestJS 12 (Express) + TypeScript, Supabase Postgres via Drizzle, Upstash Redis, Supabase Storage over S3, Resend, the official Stellar SDK. Deployed on Render. The platform layer (config, auth sessions, rate limits, audit log, errors, storage, Stellar helpers) comes from the ChuckSales backend; the marketplace is new.

| Doc | For |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, modules, identity and 2FA |
| [docs/DATABASE.md](docs/DATABASE.md) | Supabase setup, migrations, RLS, backups |
| [docs/STELLAR.md](docs/STELLAR.md) | Stellar configuration now, and the phase 2 payment design |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Render deployment step by step |
| `/docs` (Swagger UI) and `/docs-json` | Exact API contract, served by the running API |

## Build status (PRD release plan)

| Step | Scope | Status |
| --- | --- | --- |
| 1. Foundation | Auth (customers, vendors, admins, super admins; TOTP 2FA required for vendors and admins; admin idle timeout), vendor onboarding wizard with KYB documents, admin verification queue, product listings with photos and certifications, public catalogue with search and filters, store pages, guest cart pricing and merge at sign-up, product moderation, US dollar prices (1:1 with USDC) | **Done** |
| 2. Wallets and payments (testnet) | Custodial wallet service, external wallet connect, QR and payment links, payment watcher, escrow and payouts, transaction monitor | Next |
| 3. Pilot | Security review, legal sign-off, SEP-24 NGN anchor, mainnet | Later |

PRD requirements covered in step 1: V1–V3, V7 (V4–V6, V8–V9 need payments); C1–C5 (C5 delivery address arrives with checkout); A1, A3, A5–A7 (A2 and A4 report on payments).

## Local development

```bash
cp .env.example .env        # fill DATABASE_URL, REDIS_URL, JWT_ACCESS_SECRET, DATA_ENCRYPTION_KEY, FRONTEND_URL
pnpm install
pnpm build && pnpm db:migrate
ADMIN_PASSWORD='at-least-12-characters' pnpm admin:create --email you@fysi.ng --name "Your Name"
pnpm start:dev
```

- API: `http://localhost:4000/api/v1/...`
- Swagger UI: `http://localhost:4000/docs` (when `SWAGGER_ENABLED=true`)
- Health: `http://localhost:4000/health`

Without `RESEND_API_KEY`, emails (and their 6-digit codes) are printed in the terminal. Sign in as the super admin and turn on 2FA with any authenticator app (Google Authenticator, 1Password, Authy) before using the admin routes.

### E2E tests with Docker

```bash
docker run -d --name fysi-test-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=test -p 55432:5432 postgres:17
docker run -d --name fysi-test-redis -p 56379:6379 redis:8
DATABASE_URL=postgres://postgres:postgres@localhost:55432/test REDIS_URL=redis://localhost:56379 pnpm test:e2e
```

## Scripts

| Script | Purpose |
| --- | --- |
| `pnpm start:dev` | run with reload |
| `pnpm typecheck` / `pnpm lint` | `tsc --noEmit` / oxlint |
| `pnpm test` | unit tests |
| `pnpm test:e2e` | e2e against real Postgres and Redis (**disposable** instances only) |
| `pnpm smoke:stellar` | real Stellar testnet check with throwaway accounts |
| `pnpm db:generate` | generate a SQL migration after editing `src/database/schema/` |
| `pnpm db:migrate` | apply migrations from `./drizzle` (needs a prior `pnpm build`) |
| `pnpm admin:create` | create the first super admin straight in the database |
| `pnpm mail:test you@example.com` | send one of every email through Resend to check the design |
| `pnpm docs:openapi` | save the running API's OpenAPI spec to `docs/openapi.json` |

## Admins

Nobody signs up as an admin. The first **super admin** is created on the server with `pnpm admin:create` (without `ADMIN_PASSWORD` a random password is printed once). Super admins add admins with `POST /api/v1/admin/users`; the new admin gets a password setup code by email, picks a password at `POST /api/v1/auth/reset-password`, then must turn on 2FA. Admins verify vendors, moderate products and manage customers and vendors; only super admins manage other admins.
