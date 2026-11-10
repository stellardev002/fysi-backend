# Deployment: Railway

Everything runs in one Railway project: the API (built from the `Dockerfile`), **Postgres**, **Redis** and a **storage bucket** for files. Services talk over Railway's private network, and the API reads their credentials through Railway reference variables, so no secret is copied by hand. The build is **testnet only**.

```
Railway project "fysi"
├── fysi-backend   (this repo, Dockerfile)  ← public domain
├── Postgres       (Railway template)       ─┐
├── Redis          (Railway template)        ├─ private network
└── Bucket         (Railway storage bucket) ─┘
```

## What the container does

`railway.json` builds the `Dockerfile` and health-checks `GET /health`. On every start the container runs:

1. `node dist/database/migrate.js`: migrations. A failure exits non-zero and Railway keeps the previous deployment live.
2. `node scripts/platform-setup.mjs`: opens the settlement account if needed (Friendbot + USDC trustline). Idempotent; a failure is logged and only delays payments (checkout answers 503 until it succeeds).
3. `node dist/main.js`: the API on Railway's `PORT`, `0.0.0.0`.

The service must stay awake: the payment watcher confirms orders within seconds and the sweeper sends payouts. `railway.json` keeps serverless sleeping off.

## One-time setup

### 1. Push the code

```bash
git push -u origin main
```

### 2. Create the project and its services

On **railway.com** → **New Project**:

1. **Deploy from GitHub repo** → `fysi-backend`. Railway reads `railway.json`. The first deploy fails until the variables below are set; that is expected.
2. **+ Create → Database → PostgreSQL** (service name `Postgres`).
3. **+ Create → Database → Redis** (service name `Redis`).
4. **+ Create → Bucket** (service name `Bucket`). Open its **Credentials** tab and note whether it says *virtual-hosted* or *path* style (new buckets are virtual-hosted).

Keep all four in one region close to your users.

### 3. Variables on `fysi-backend`

Service → **Variables** → **Raw Editor**, paste this block:

```
NODE_ENV=production
APP_NAME=fysi
LOG_LEVEL=info
TRUST_PROXY_HOPS=1
SWAGGER_ENABLED=true

DATABASE_URL=${{Postgres.DATABASE_URL}}
DB_POOL_MAX=5
REDIS_URL=${{Redis.REDIS_URL}}

JWT_ACCESS_SECRET=
DATA_ENCRYPTION_KEY=
FRONTEND_URL=
CORS_ORIGINS=

S3_BUCKET=${{Bucket.BUCKET}}
S3_ENDPOINT=${{Bucket.ENDPOINT}}
S3_REGION=${{Bucket.REGION}}
S3_ACCESS_KEY_ID=${{Bucket.ACCESS_KEY_ID}}
S3_SECRET_ACCESS_KEY=${{Bucket.SECRET_ACCESS_KEY}}
S3_FORCE_PATH_STYLE=false

STELLAR_NETWORK=testnet
STELLAR_ASSETS=USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
WALLET_PROVIDER=local
MFA_REQUIRED_ROLES=vendor,admin,super_admin

MAIL_CONSOLE_IN_PRODUCTION=true
```

Fill the three empty values **in Railway only**. Never write real values into this file or anything else in the repository: it is public.

| Variable | Value |
| --- | --- |
| `JWT_ACCESS_SECRET` | Output of `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"` |
| `DATA_ENCRYPTION_KEY` | Output of `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. **Keep a copy in a password manager** |
| `FRONTEND_URL` | The web app's address, e.g. `https://fysi.ng` (`http://localhost:3000` until it is deployed) |

- `MAIL_CONSOLE_IN_PRODUCTION=true` writes emails (sign-up codes included) to the deploy logs while there is no email provider. Without it, or `RESEND_API_KEY` + `MAIL_FROM`, the API refuses to start.
- `S3_FORCE_PATH_STYLE=true` only if the bucket's Credentials tab says path style.

- `${{Service.VAR}}` are Railway reference variables: they stay in sync if Railway rotates a password. If you named a service differently, use its name.
- `DATABASE_URL` and `REDIS_URL` use the private network (`*.railway.internal`). The Redis client resolves IPv4 and IPv6, which Railway's private network needs.
- **`DATA_ENCRYPTION_KEY`**: store it in a password manager. Losing it makes every 2FA secret, director ID and testnet custodial key unreadable.
- Use the bucket's `BUCKET` value, not `RAILWAY_BUCKET_NAME` (Railway documents that one as not the S3 name).

### 4. Public domain

`fysi-backend` → **Settings → Networking → Generate Domain**. Railway's edge proxy forwards the client IP, hence `TRUST_PROXY_HOPS=1`.

Saving variables redeploys. Watch **Deployments → Logs** for `Migrations applied` and `Settlement account ready: G…`.

### 5. First super admin

Railway CLI (`npm i -g @railway/cli`, `railway login`, `railway link` in this folder):

```bash
railway ssh
ADMIN_PASSWORD='a-long-password' node scripts/create-admin.mjs --email you@fysi.ng --name "Your Name"
```

Or from your laptop against the database's **public** URL (Postgres → **Connect** → *Public network*, `DATABASE_PUBLIC_URL`):

```bash
DATABASE_URL='<public postgres url>' ADMIN_PASSWORD='a-long-password' pnpm admin:create --email you@fysi.ng --name "Your Name"
```

Sign in and turn on 2FA straight away; rotate that password after the first login.

### 6. Verify

- `https://<domain>/health` → `"status":"ok"`, database and redis `up`.
- `https://<domain>/api/v1/stellar/network` → `"network":"testnet"`.
- `https://<domain>/docs` → Swagger UI.
- Sign in as the super admin in Swagger (`POST /api/v1/auth/login`), set up 2FA, then approve a test vendor: its wallet should become `active` within seconds (`GET /api/v1/vendor/wallet`).
- Test payments with USDC from **faucet.circle.com** (Stellar testnet) in a Freighter or LOBSTR wallet switched to testnet.

## Day to day

- **Deploys**: every push to `main` redeploys (migrations and settlement check included).
- **Logs**: service → **Deployments → Logs**. With `MAIL_CONSOLE_IN_PRODUCTION=true`, search `code is` to find sign-up and withdrawal codes.
- **Variables**: saving restarts the service.
- **Database from your laptop**: use `DATABASE_PUBLIC_URL` (Postgres service → Connect). The private URL only works inside Railway.
- **Backups**: Postgres service → **Backups** (plan-dependent), and take a `pg_dump` before risky migrations (see DATABASE.md).
- **Email check**: `pnpm mail:test you@example.com` sends one of every email through Resend using `.env`.
- **Staging email with Resend's test sender**: `RESEND_API_KEY`, `MAIL_FROM=Fysi <onboarding@resend.dev>`, `MAIL_REDIRECT_TO=<the Resend account owner>`; every email lands in that inbox, subject prefixed `[to <real recipient>]`.
- **Dependencies**: `pnpm audit:deps` (also in CI).

## Costs

Railway bills usage: the always-on API, Postgres and Redis on the Hobby plan, plus bucket storage per GB. Bucket API calls and bucket egress are free, and files reach browsers straight from the bucket through signed links, so photos do not load the API.

## Before real users (checklist)

- [ ] Real email: verify a domain in Resend, set `RESEND_API_KEY` and `MAIL_FROM`, set `MAIL_CONSOLE_IN_PRODUCTION=false`, clear `MAIL_REDIRECT_TO`.
- [ ] `FRONTEND_URL` / `CORS_ORIGINS` list only the real frontend domains.
- [ ] Decide whether Swagger stays public (`SWAGGER_ENABLED`).
- [ ] `DATA_ENCRYPTION_KEY` and `JWT_ACCESS_SECRET` stored in a password manager.
- [ ] Postgres backups enabled and a `pg_dump` taken.
- [ ] Testnet only: `STELLAR_NETWORK=testnet` with Circle's testnet USDC issuer. Mainnet is not supported by this build.
