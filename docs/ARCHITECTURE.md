# Architecture

Fysi is a marketplace for certified eco-friendly products, paid in USDC on Stellar (PRD: Fysi Marketplace MVP on Stellar, 6 Nov 2026). This repository is the API; the web app is a separate repository.

```
Next.js frontend (separate repo)
        │  HTTPS, JSON, Bearer tokens
        ▼
NestJS API  /api/v1 ──────────────► Stellar (Horizon): USDC payments, custodial wallets
   │        │        │
   ▼        ▼        ▼
Postgres  Redis          Bucket (S3 API)        all on Railway
(Drizzle) (rate limits)  photos, logos, KYB documents
```

| Piece | Hosting | Role |
| --- | --- | --- |
| NestJS API (this repo) | Railway (Dockerfile, always on) | All business logic, authorization, verification workflow, payment watcher |
| Postgres | Railway Postgres (private network) | Accounts, vendors, products, orders, payments, audit log |
| Redis | Railway Redis (private network) | Token-bucket rate limiting (fails open if Redis is down) |
| Object storage | Railway storage bucket (S3 API, private) | Product photos, logos, avatars, vendor documents; served by short-lived signed links |
| Email | Resend (console in dev/staging) | Codes, admin invites, vendor decisions |
| Stellar | SDF Horizon | Settlement account, custodial wallets, payment watcher, payouts (see STELLAR.md) |

## Request pipeline

1. **Request context**: `x-request-id` and a W3C trace id on every log line and error body.
2. **Helmet, CORS** (`FRONTEND_URL` + `CORS_ORIGINS`), 100 kB JSON limit (uploads are multipart, 5 MB images, 10 MB documents).
3. **Global guards**: `JwtAuthGuard` (verifies the access token and that its session is live; refuses vendor and admin sessions without 2FA except on `@AllowWithoutMfa()` routes) → `RateLimitGuard` → `RolesGuard` (`@Roles(...)`) → `PoliciesGuard` (CASL).
4. **ValidationPipe**: class-validator DTOs; unknown fields are rejected, so roles, statuses and ids cannot be set through bodies.
5. **Controller → service → queries**: services hold business rules; `*.queries.ts` hold Drizzle queries. Writes take a transaction, so audit rows commit or roll back with the change they describe.
6. **ResponseInterceptor** wraps success as `{ statusCode, message, data }`; **AllExceptionsFilter** shapes every error the same way.

## Modules

| Module | Responsibility |
| --- | --- |
| `config` | Environment validation (fails fast on bad config) |
| `database` | Postgres pool, Drizzle, transactions, advisory locks, migrator |
| `common` | Request context, response envelope, errors, pagination, Swagger helpers, `SecretBox` (AES-256-GCM for sensitive columns), slugs |
| `auth` | Customer and vendor sign-up, email verification, login with TOTP 2FA (`totp.ts`, RFC 6238), refresh rotation with reuse detection, password reset and change, profile and avatar, `MfaPolicy` |
| `authorization` | Roles (`customer`, `vendor`, `admin`, `super_admin`) and CASL abilities |
| `users` | Admin account management: list, create admins (super admins), suspend, restore, reset 2FA |
| `audit` | Append-only audit log (DB trigger) with before/after snapshots; the PRD activity log (A3) |
| `vendors` | Onboarding wizard (`onboarding.ts` holds the rules), KYB documents, submission; admin verification queue and decisions; decision emails |
| `products` | Vendor product CRUD and photos; the public catalogue (search, filters, product and store pages); admin moderation; money helpers (`pricing.ts`: cents, USDC stroops, commission, exact integer maths); `visibility.ts`, the one rule for what customers can see |
| `cart` | Guest cart pricing, customer cart, guest→account merge (`merge.ts`) |
| `categories` | Public category list with counts; admin create, rename, reorder, deactivate |
| `mail` | Mailer abstraction (Resend or console) and the branded, responsive templates |
| `storage` | Object storage abstraction; image and document type checks by bytes |
| `stellar` | Network config, asset/amount/address rules, Horizon ledger, transaction builders and SEP-7 (see STELLAR.md) |
| `wallets` | Custody provider (`custody.ts`), wallet service: sponsored account activation, balances, platform-signed and fee-bumped transfers, settlement setup |
| `orders` | Checkout (stock hold, per-vendor split, commission), payment methods, customer order actions, vendor fulfilment, pay page; `rules.ts` holds the money rules |
| `payments` | Payment watcher, escrow, payouts / refunds / withdrawals, scheduler, order emails, customer and vendor wallet views, admin transaction monitor and dashboard |
| `storefront` | Customer wishlist and saved addresses (checkout takes an `addressId`) |
| `reviews` | Verified-purchase reviews (one per delivered order line), rating summaries, vendor view, admin hide/unhide |
| `promotions` | Vendor sales: percent off chosen products or the whole store between two dates. `products/promotion-price.ts` applies the biggest running discount in the catalogue, cart and checkout; order lines keep the list price and promotion id |
| `notifications` | In-app inbox for every role (global module: orders, payments, vendors and support write to it) and admin announcements |
| `support` | Help desk: Report a Problem form (signed in or guest), order problem reports open a high-priority ticket, threaded replies, admin queue, assignment and emails |
| `marketing` | Newsletter (subscribe, HMAC unsubscribe links, account setting) and admin email campaigns sent in batches by their own sweeper under an advisory lock |
| `analytics` | Vendor dashboard, sales analytics, product stats (views counted per day on product pages), account statements; marketplace analytics; CSV exports (`common/csv.ts` guards against formula injection) |
| `rate-limit`, `redis`, `health` | Token bucket, Redis client, `/health` |

## Identity and sessions

| Who | Sign-in | Second factor | Session |
| --- | --- | --- | --- |
| Customer | Email + password (argon2), email verified by code | Optional TOTP | Refresh token valid `REFRESH_TOKEN_TTL_DAYS` from the last refresh |
| Vendor | Same | Optional TOTP | Same |
| Admin, super admin | Same; created by a super admin or `pnpm admin:create` | Optional TOTP | Idle timeout `ADMIN_SESSION_IDLE_MINUTES` |

- Access JWTs (15 min, HS256) carry `role`, the session family and `mfa`. Every request checks the session row, so logout, password reset, 2FA changes and suspension take effect immediately.
- With 2FA on, `POST /auth/login` returns a 5-minute `mfaToken`; `POST /auth/login/2fa` exchanges it and a code for tokens. Each 30-second code works once per account; a password change voids pending `mfaToken`s.
- Turning 2FA on revokes every session and returns a fresh, 2FA-verified pair. Access is by role. `MFA_REQUIRED_ROLES` (empty by default) can make 2FA mandatory for chosen roles again: those sessions then reach only `/auth/me`, `/auth/2fa/*` and sign-out until it is on (403 `Turn on two-factor sign-in to continue`).
- TOTP secrets and directors' NIN/BVN are encrypted with `DATA_ENCRYPTION_KEY`, bound to their row; the API never returns them (NIN/BVN: last 4 digits only).

## Vendor lifecycle (PRD V1–V3, A1)

```
draft ──submit──► pending ──approve──► approved ◄──reinstate── suspended
  ▲                  │                    └──────suspend──────────┘
  └──── rejected ◄───┘ reject (reason shown to the vendor; fix and resubmit)
```

- Submitting needs business name, phone, address, state, category, CAC number, director NIN/BVN, a CAC certificate, and a sustainability certificate (with its label) or evidence.
- Approval fixes the storefront slug and records the accepted labels: with one or more, the store and its products show **Certified**; without, **Fysi Reviewed** (PRD accepted-certifications decision). Products may only claim the store's verified labels.
- Identity fields and documents lock from submission; description, phone and logo stay editable.
- Approval creates the vendor's custodial wallet (PRD V4).

## What customers can see

One SQL rule (`products/visibility.ts`) drives the catalogue, product pages, category counts and carts: the product is `active`, not hidden or removed by an admin, not deleted, its store is `approved` and the owner account is not suspended.

## Money

Prices are US dollars held as integer cents and are paid 1:1 in USDC, so there is no exchange rate and no quote risk. 1 cent = 100,000 USDC stroops; conversions are exact integers. No floats. (The PRD's naira pricing is deferred: it returns with the NGN anchor at the pilot.)

## Repository layout

```
src/            application code, one folder per module
drizzle/        SQL migrations (generated + hand-written)
test/           e2e tests (real Postgres and Redis; fake mailer, storage and ledger)
scripts/        create-admin, mail-test, stellar-smoke, export-openapi
docs/           this documentation
Dockerfile      build → migrate → settlement setup → start
railway.json    Railway build and deploy settings
```

## Order lifecycle

```
cart ──checkout──► order awaiting_payment ──USDC + memo──► paid ─┬─► vendor order: paid → processing → shipped → delivered
                    │  (stock held 15 min)                         │    escrow: held ─confirm / 7 days─► released ─► paid_out
                    └─expired / cancelled (stock back)            │                └─problem─► disputed ─admin─► released | refunded
                                                                   └─ one vendor order per store in the cart
```

- A vendor can cancel a vendor order before shipping (`paid` or `processing`, escrow `held`): the subtotal is refunded to the paying address, stock goes back and the customer is emailed. After shipping, or once a problem is reported, only an admin can refund.
- Reporting a problem also opens a help desk ticket linked to the vendor order.

## Deleting a customer

`DELETE /admin/users/{id}` anonymises rather than removes the row, because orders and payments reference it: name, email (freed for a new sign-up), phone, photo, password, 2FA, sessions, cart, wishlist, addresses, inbox and newsletter entry are erased; orders, payments and reviews stay ("Deleted customer" / "Fysi customer"). It is refused while an order is partly paid or has payment in escrow, or while the customer's Fysi wallet holds funds. Vendors are suspended, never deleted.
