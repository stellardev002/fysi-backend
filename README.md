# fysi-backend

API for **Fysi**, a marketplace for certified eco-friendly products with payments settled in USDC on Stellar. Verified vendors sign up and sell; customers browse and keep a cart without an account, then sign up to buy; admins verify vendors and moderate the catalogue.

**Runs on the Stellar testnet only**: no real money moves, and the app refuses to start with any mainnet setting.

NestJS 12 (Express) + TypeScript, Postgres via Drizzle, Redis, S3-compatible storage, Resend, the official Stellar SDK. Deployed on **Railway** (API, Postgres, Redis and a storage bucket in one project; see `railway.json`). The platform layer (config, auth sessions, rate limits, audit log, errors, storage, Stellar helpers) comes from the ChuckSales backend; the marketplace is new.

| Doc | For |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, modules, identity and 2FA |
| [docs/DATABASE.md](docs/DATABASE.md) | Postgres connections, migrations, backups |
| [docs/STELLAR.md](docs/STELLAR.md) | Stellar configuration now, and the phase 2 payment design |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Railway deployment step by step |
| `/docs` (Swagger UI) and `/docs-json` | Exact API contract, served by the running API |

## Build status (PRD release plan)

| Step | Scope | Status |
| --- | --- | --- |
| 1. Foundation | Auth (customers, vendors, admins, super admins; optional TOTP 2FA; role-based access; admin idle timeout), vendor onboarding wizard with KYB documents, admin verification queue, product listings with photos and certifications, public catalogue with search and filters, store pages, guest cart pricing and merge at sign-up, product moderation, US dollar prices (1:1 with USDC) | **Done** |
| 2. Wallets and payments (testnet) | Custody provider interface (encrypted local keys on testnet), sponsored custodial wallets for vendors (on approval) and customers (opt-in, PIN), settlement account, checkout with stock hold and multi-vendor split, four payment methods (external wallet, Fysi wallet, SEP-7 QR, payment link), payment watcher with replay, under/overpaid and unmatched handling, escrow with commission, confirm delivery, problem reports, automatic release, payouts, vendor withdrawals (password + email code, daily limit), admin refunds, transaction monitor, dashboard, order emails | **Done** |
| 2b. Screens | Storefront: wishlist, reviews and pending reviews, inbox, newsletter, Report a Problem / help desk, saved addresses. Vendor: dashboard and analytics, account statements, promotions, Track Orders search, product stats, CSV exports, order cancel. Admin: email campaigns, marketplace analytics, announcements, help tickets, adding products for vendors, deleting customers, CSV exports | **Done** |
| 3. Pilot | Security review, legal sign-off, SEP-24 NGN anchor, MPC custody | Later (mainnet is not part of this build) |

PRD requirements covered: V1–V9 (V6 bank cash-out waits for the NGN anchor), C1–C9 (C9 funding by deposit address and QR; anchor deposits at the pilot), A1–A7.

## Local development

```bash
cp .env.example .env        # fill DATABASE_URL, REDIS_URL, JWT_ACCESS_SECRET, DATA_ENCRYPTION_KEY, FRONTEND_URL
pnpm install
pnpm build && pnpm db:migrate
pnpm platform:setup        # opens the settlement account (testnet: Friendbot + USDC trustline)
ADMIN_PASSWORD='at-least-12-characters' pnpm admin:create --email you@fysi.ng --name "Your Name"
pnpm start:dev
```

- API: `http://localhost:4000/api/v1/...`
- Swagger UI: `http://localhost:4000/docs` (when `SWAGGER_ENABLED=true`)
- Health: `http://localhost:4000/health`

Without `RESEND_API_KEY`, emails (and their 6-digit codes) are printed in the terminal. Sign in as the super admin to use the admin routes (2FA is optional).

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
| `pnpm platform:setup` | open the settlement account (idempotent) |
| `pnpm mail:test you@example.com` | send one of every email through Resend to check the design |
| `pnpm docs:openapi` | save the running API's OpenAPI spec to `docs/openapi.json` |

## Admins

Nobody signs up as an admin. The first **super admin** is created on the server with `pnpm admin:create` (without `ADMIN_PASSWORD` a random password is printed once). Super admins add admins with `POST /api/v1/admin/users`; the new admin gets a password setup code by email, picks a password at `POST /api/v1/auth/reset-password`. Admins verify vendors, moderate products and manage customers and vendors; only super admins manage other admins.
