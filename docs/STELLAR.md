# Stellar integration

Every Fysi order is paid in **USDC on Stellar** (PRD). Phase 1 ships the foundation only: network configuration, asset, amount and address rules, a Horizon client and account lookups. Payments, wallets and payouts are phase 2.

## Configuration

Nothing about the network is hardcoded outside `src/stellar/stellar.config.ts`.

| Variable | Default | Notes |
| --- | --- | --- |
| `STELLAR_NETWORK` | `testnet` | `testnet` or `mainnet`: passphrase, default Horizon and explorer |
| `STELLAR_ALLOW_MAINNET` | `false` | Must also be `true` to boot on mainnet; flip only after the security review and legal sign-off |
| `STELLAR_HORIZON_URL` | SDF public Horizon | Override for a paid Horizon provider |
| `STELLAR_ASSETS` | — | Settlement asset as `CODE:ISSUER`. Fysi uses **USDC only**: testnet `USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` (Circle); mainnet has a different issuer |
| `STELLAR_PLATFORM_SECRET` | empty | Unused in phase 1 |

Assets are identified everywhere by `CODE:ISSUER`, never by code alone, so a lookalike `USDC` from another issuer is a different asset. Amounts are integer stroops (7 decimals) with no floats.

## Module layout (`src/stellar/`)

| File | Responsibility |
| --- | --- |
| `stellar.config.ts` | Network passphrase, Horizon URL, explorer links, asset allowlist, mainnet guard |
| `address.ts` | `G...` address validation (checksum; muxed and contract addresses rejected) |
| `amounts.ts` | Decimal strings ↔ integer stroops (`bigint`), int64 bound |
| `assets.ts` | Allowlist parsing; SDK `Asset` conversion |
| `ledger.ts` | `StellarLedger` interface and its Horizon implementation (accounts, balances, submit, transaction lookup) |
| `signer.ts` | `PlatformSigner` interface; phase 2 replaces it with the custody provider |
| `stellar.controller.ts` | `GET /api/v1/stellar/network`, `GET /api/v1/stellar/accounts/{address}` |

## Phase 2 design (from the PRD; to confirm before building)

| Piece | Plan |
| --- | --- |
| Settlement | Every order pays the Fysi settlement account, matched by a unique memo (`fy-…`); funds held in escrow, paid to the vendor's custodial wallet minus 5% commission on delivery confirmation or 7 days after Shipped |
| Wallet service | `WalletProvider` interface: DFNS (MPC) for pilot and mainnet; an encrypted local-key implementation for testnet only, refused on mainnet like the mainnet guard |
| Vendor wallet | Created on approval with a sponsored USDC trustline; fees paid by fee-bump |
| Payment methods | External wallet: build → sign → submit pinned by hash (reused from ChuckSales `payment.ts`). Fysi wallet: PIN-confirmed custodial payment. QR and link: SEP-7 `web+stellar:pay` request, confirmed by the watcher |
| Payment watcher | Streams payments into the settlement account; saves the Horizon paging token to resume after downtime; one row per payment operation, unique on (transaction hash, operation index), so no order is marked paid twice; handles underpaid, overpaid and unmatched payments |
| Ledger | Double-entry entries for escrow, commission and payouts, reconciled against on-chain balances |
| Hosting | Always-on instance (paid Render plan or a separate worker) |

Open questions to settle first: rate source for quotes, repricing an underpayment after the quote expires, who marks Delivered, the settlement account's signing set, and how the ₦300,000 Tier 1 cap applies to on-chain deposits.

## Testing

| Level | Command | What it proves |
| --- | --- | --- |
| Unit | `pnpm test` | Amount maths, address and asset validation, network config, mainnet guard |
| E2E | `pnpm test:e2e` | The HTTP endpoints, with a fake ledger |
| Testnet smoke | `pnpm smoke:stellar` | Real testnet: Friendbot funding, Horizon lookups, a payment built, signed, submitted and confirmed |
