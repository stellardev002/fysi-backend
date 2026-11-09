# Payments on Stellar

Every Fysi order is paid in **USDC on Stellar** into the Fysi settlement account, matched to the order by its memo, held in escrow, then paid to the vendor's custodial wallet minus commission (PRD "Payments on Stellar"). Prices are US dollars and USDC is 1:1, so there is no exchange rate or quote risk.

## Accounts

| Account | Who | Created | Signs |
| --- | --- | --- | --- |
| Settlement | Platform | `pnpm platform:setup` (also on every container start, idempotent) | Custody provider |
| Vendor wallet | Every approved vendor | On approval (PRD V4); retried by the sweeper if the network is slow | Custody provider; withdrawals need password + emailed code |
| Customer wallet | Customers who opt in (`POST /wallet`) | On request; needs a phone number (KYC Tier 1) | Custody provider; each payment needs the 6-digit PIN |
| External wallet | Customers who self-custody | Their own (Freighter, LOBSTR, xBull, Albedo, WalletConnect) | The customer, in their wallet |

Custodial accounts are opened with **sponsored reserves** (the settlement account sponsors the account and its USDC trustline, so it starts with 0 XLM) and every transaction from them is **fee-bumped** by the settlement account. Users never hold XLM. Verified on the real testnet: a custodial wallet opens with `XLM 0.0000000` and a USDC trustline.

## Custody

`src/wallets/custody.ts` defines `CustodyProvider` (create a key, sign a transaction). Nothing else sees key material.

| `WALLET_PROVIDER` | Where keys live | Network |
| --- | --- | --- |
| `local` | Encrypted with `DATA_ENCRYPTION_KEY` (AES-256-GCM, bound to the public key) in the `wallets` table | **Testnet only**: the app refuses to boot with it on mainnet |
| (pilot) DFNS or another MPC provider | The provider | Implement `CustodyProvider`; nothing else changes |

## Payment methods (PRD C6)

All four pay the settlement account in USDC with the order number (e.g. `FYK3M9QXWA`) as a text memo, so one watcher confirms them all.

| Method | Flow |
| --- | --- |
| Connect external wallet | `POST /orders/{id}/pay/external` builds the payment (amount due, USDC, memo) from the customer's address → the wallet signs → `/pay/external/submit` checks it pays the right account, asset and memo, and submits |
| Fysi wallet | `POST /orders/{id}/pay/wallet` with the PIN: Fysi signs from the customer wallet, fee-bumped. Refused with a "fund your wallet" prompt when the balance is short. 5 wrong PINs lock it for 15 minutes |
| QR code | `payment.sep7Uri` is a SEP-7 `web+stellar:pay` request (destination, amount, USDC, memo; testnet adds the network passphrase). Any SEP-7 wallet pre-fills it |
| Payment link | `payment.payLink` opens the hosted pay page; `GET /pay/{token}` serves it without an account or personal data, so the link can be sent to someone else |

## Payment watcher

`src/payments/watcher.service.ts` reads the settlement account's payments from Horizon every `WATCHER_INTERVAL_MS` (default 3 s) and right after every submit through the API.

- Each payment becomes one `payments` row keyed by the **operation id** (unique), and the Horizon paging token is saved in the same transaction. After downtime it replays from the last token; a replay finds the operation already recorded and changes nothing, so **no order is ever paid twice** (tested by deleting the cursor and replaying).
- Matching: USDC + memo = an open order's number.
  - Short: the order stays open with the balance due; the window extends to `PARTIAL_PAYMENT_GRACE_HOURS` (default 24) after the first payment.
  - Exact: paid. Over: paid, and the excess is flagged for refund.
  - No memo, unknown memo, an order that already closed, or another asset: `unmatched`, flagged for an admin refund.
- When an order is paid: vendor orders become `paid`, escrow `held`, the bought items leave the cart, the customer gets the confirmation email with the transaction hash (C7) and each vendor gets a new-order email (V9).

## Escrow, payouts, refunds

| Step | Rule |
| --- | --- |
| Commission | `COMMISSION_BPS` (500 = 5%) fixed per vendor order at checkout; 0 for founding vendors within `FOUNDING_VENDOR_FREE_DAYS` (90) of approval |
| Held | Paid funds stay in the settlement account; vendors see them as **pending** |
| Release | The customer confirms delivery, or `ESCROW_AUTO_RELEASE_DAYS` (7) after the vendor marks Shipped. Marking Delivered alone releases nothing |
| Dispute | "Report a problem" (from shipping until 7 days after delivery) holds the payout until an admin releases or refunds |
| Payout | A `payouts` row; the sweeper sends subtotal − commission to the vendor wallet |
| Refund | Admin only: a whole vendor order before payout, or a flagged payment's refundable amount, to the address that paid |
| Withdrawal | Vendor: external address with a USDC trustline, password + emailed code, `WITHDRAWAL_DAILY_LIMIT_CENTS` per 24 h |

Payouts, refunds and withdrawals share one lifecycle (`src/payments/transfers.service.ts`): the transaction hash is stored **before** submitting, so a lost response is settled by looking the hash up, never by sending again. Sequence races and a wallet still opening are retried; other failures stop with a plain-language error for an admin to retry. Settlement-sourced transactions run one at a time under a Postgres advisory lock (they share a sequence number).

## Background work

`PaymentsScheduler` runs the watcher (every 3 s) and the sweeper (every 30 s: expire checkouts and put stock back, auto-release escrow, open pending wallets, send transfers). It needs an **always-on** instance; on a sleeping host nothing is lost, but confirmations wait for a wake-up.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `STELLAR_NETWORK` | `testnet` | `mainnet` also needs `STELLAR_ALLOW_MAINNET=true`, and a real custody provider |
| `STELLAR_ASSETS` | — | `USDC:<issuer>`. Testnet: `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` (Circle) |
| `WALLET_PROVIDER` | `local` | See Custody |
| `PAYMENT_WINDOW_MINUTES` | 15 | Stock hold, QR and link validity |
| `CUSTOMER_TIER1_CAP_CENTS` | 20000 | ≈ ₦300,000; shown as `overCap` (deposits cannot be blocked on chain) |

## Not yet (pilot)

- NGN deposits and bank cash-out through a SEP-24 anchor; Tier 2 KYC (BVN/NIN) through Smile ID or Dojah.
- An MPC custody provider; multi-signature settlement with sweeps to a cold account; security review.
- Testnet USDC for manual testing comes from Circle's faucet (faucet.circle.com).

## Testing

| Level | What it proves |
| --- | --- |
| Unit (`pnpm test`) | Amounts, SEP-7 encoding, transaction builders (sponsored activation, fee bump, hash pinning), payment matching, commission, escrow rules |
| E2E (`pnpm test:e2e`, `test/payments.e2e-spec.ts`) | The whole loop on an in-memory Stellar (`test/fake-chain.ts`: sequences, signatures, sponsorship, fee bumps, paged history): checkout, all four payment methods, partial and over payment, expiry, replay without double counting, shipping, confirmation, auto-release, payouts, disputes, refunds, withdrawals |
| Real testnet | `pnpm platform:setup` (Friendbot + trustline) and a sponsored custodial wallet opened with 0 XLM |
