import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  Account,
  Operation,
  type Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { Database, type Tx } from '../database/database.js';
import type { WalletKind } from '../database/schema/index.js';
import { toStroops } from '../stellar/amounts.js';
import { toSdkAsset } from '../stellar/assets.js';
import {
  LedgerUnavailableError,
  StellarLedger,
  type SubmitOutcome,
} from '../stellar/ledger.js';
import { StellarConfig } from '../stellar/stellar.config.js';
import {
  buildActivation,
  buildPayment,
  feeBump,
  type TxContext,
  txExpiry,
  txHash,
} from '../stellar/transactions.js';
import { type CustodyKey, CustodyProvider } from './custody.js';
import {
  findSettlement,
  insertWallet,
  pendingWallets,
  updateWallet,
  type WalletRow,
} from './wallets.queries.js';

/** Platform-signed transactions live this long before they can no longer land. */
const TX_TTL_SECONDS = 180;
const MAX_ACTIVATION_ATTEMPTS = 20;

export interface BuiltTransfer {
  xdr: string;
  /** Hash to look the transaction up by (the fee bump's, when bumped). */
  hash: string;
  expiresAt: Date;
}

export const keyOf = (w: WalletRow): CustodyKey => ({
  publicKey: w.publicKey,
  ref: w.providerRef,
});

/**
 * Fysi's wallet service (PRD: custodial wallets behind Fysi's own service so
 * the custody provider can be swapped). Opens sponsored accounts, reads USDC
 * balances and builds platform-signed transfers. The settlement account pays
 * every reserve and fee, so users never hold XLM.
 */
@Injectable()
export class WalletsService {
  private readonly logger = new Logger(WalletsService.name);

  constructor(
    private readonly database: Database,
    private readonly ledger: StellarLedger,
    private readonly stellar: StellarConfig,
    private readonly custody: CustodyProvider,
  ) {}

  get asset() {
    return this.stellar.settlementAsset;
  }

  /** Creates the key and the row; the account opens on chain with `activate`. */
  async create(
    tx: Tx,
    kind: Exclude<WalletKind, 'settlement'>,
    userId: string,
    extra: { kycTier?: number; pinHash?: string } = {},
  ): Promise<WalletRow> {
    const key = await this.custody.createKey();
    return insertWallet(tx, {
      kind,
      userId,
      publicKey: key.publicKey,
      provider: this.custody.name,
      providerRef: key.ref,
      ...extra,
    });
  }

  /** The active settlement account, or 503 while payments are not set up. */
  async settlement(): Promise<WalletRow> {
    const w = await findSettlement(this.database.db);
    if (w?.status !== 'active')
      throw new ServiceUnavailableException(
        'Payments are not available yet: the settlement account is not set up',
      );
    return w;
  }

  /**
   * Creates the settlement account, funds it with Friendbot's test XLM and adds
   * the USDC trustline. Idempotent: `pnpm platform:setup` and tests call it.
   */
  async setupSettlement(): Promise<WalletRow> {
    let w = await findSettlement(this.database.db);
    if (!w) {
      const key = await this.custody.createKey();
      w = await this.database.transaction((tx) =>
        insertWallet(tx, {
          kind: 'settlement',
          publicKey: key.publicKey,
          provider: this.custody.name,
          providerRef: key.ref,
        }),
      );
    }
    let account = await this.ledger.loadAccount(w.publicKey);
    if (!account) {
      await this.ledger.fundWithFriendbot(w.publicKey);
      account = await this.ledger.loadAccount(w.publicKey);
      if (!account) throw new Error('Friendbot did not fund the settlement account');
    }
    if (!account.balances.some((b) => b.assetId === this.asset.id)) {
      const ctx = await this.ctx();
      const tx = new TransactionBuilder(
        new Account(account.address, account.sequence),
        {
          fee: String(ctx.fee),
          networkPassphrase: ctx.networkPassphrase,
          timebounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) + TX_TTL_SECONDS },
        },
      )
        .addOperation(Operation.changeTrust({ asset: toSdkAsset(this.asset) }))
        .build();
      await this.custody.sign(keyOf(w), tx);
      const outcome = await this.ledger.submit(
        tx.toEnvelope().toXDR('base64'),
        ctx.networkPassphrase,
      );
      if (outcome.kind !== 'success')
        throw new Error(`USDC trustline failed: ${outcome.codes.join(', ')}`);
    }
    await updateWallet(this.database.db, w.id, {
      status: 'active',
      activatedAt: w.activatedAt ?? new Date(),
    });
    return { ...w, status: 'active' };
  }

  /**
   * Opens the wallet's account on chain with a USDC trustline, reserves
   * sponsored by the settlement account. Returns true once it is active.
   * Safe to retry: an account that already exists is just marked active.
   */
  async activate(wallet: WalletRow): Promise<boolean> {
    if (wallet.status === 'active') return true;
    try {
      const existing = await this.ledger.loadAccount(wallet.publicKey);
      if (existing?.balances.some((b) => b.assetId === this.asset.id)) {
        await this.markActive(wallet);
        return true;
      }
      const settlement = await this.settlement();
      return await this.withSettlement(async () => {
        const sponsor = await this.ledger.loadAccount(settlement.publicKey);
        if (!sponsor) throw new Error('Settlement account missing on chain');
        const tx = buildActivation(sponsor, wallet.publicKey, this.asset, await this.ctx());
        await this.custody.sign(keyOf(settlement), tx);
        await this.custody.sign(keyOf(wallet), tx);
        const outcome = await this.ledger.submit(
          tx.toEnvelope().toXDR('base64'),
          this.stellar.networkPassphrase,
        );
        if (outcome.kind === 'success') {
          await this.markActive(wallet);
          return true;
        }
        await this.recordActivationFailure(wallet, outcome.codes.join(', '));
        return false;
      });
    } catch (err) {
      await this.recordActivationFailure(
        wallet,
        err instanceof Error ? err.message : String(err),
      );
      if (!(err instanceof LedgerUnavailableError || err instanceof ServiceUnavailableException))
        this.logger.error({ err, walletId: wallet.id }, 'Wallet activation failed');
      return false;
    }
  }

  /** Sweeper: retries wallets whose account is not on chain yet. */
  async activatePending(): Promise<number> {
    let done = 0;
    for (const w of await pendingWallets(this.database.db, MAX_ACTIVATION_ATTEMPTS, 20))
      if (w.kind !== 'settlement' && (await this.activate(w))) done++;
    return done;
  }

  /** USDC held on chain, in stroops; null when the account does not exist yet. */
  async balance(publicKey: string): Promise<bigint | null> {
    const account = await this.ledger.loadAccount(publicKey);
    if (!account) return null;
    const line = account.balances.find((b) => b.assetId === this.asset.id);
    return line ? toStroops(line.balance) : 0n;
  }

  /**
   * A signed USDC payment from a custodial wallet, fee-bumped by the
   * settlement account (the wallet holds no XLM).
   */
  async buildFromCustodial(
    wallet: WalletRow,
    p: { destination: string; amount: bigint; memo: string },
  ): Promise<BuiltTransfer> {
    const settlement = await this.settlement();
    const source = await this.ledger.loadAccount(wallet.publicKey);
    if (!source) throw new ServiceUnavailableException('This wallet is not open on the network yet');
    const ctx = await this.ctx();
    const inner = buildPayment(source, { ...p, asset: this.asset }, ctx);
    await this.custody.sign(keyOf(wallet), inner);
    const bumped = feeBump(inner, settlement.publicKey, { ...ctx, fee: ctx.fee * 2 });
    await this.custody.sign(keyOf(settlement), bumped);
    return {
      xdr: bumped.toEnvelope().toXDR('base64'),
      hash: txHash(bumped),
      expiresAt: txExpiry(inner),
    };
  }

  /** A signed USDC payment from the settlement account (payouts, refunds). */
  async buildFromSettlement(p: {
    destination: string;
    amount: bigint;
    memo: string;
  }): Promise<BuiltTransfer> {
    const settlement = await this.settlement();
    const source = await this.ledger.loadAccount(settlement.publicKey);
    if (!source) throw new Error('Settlement account missing on chain');
    const tx = buildPayment(source, { ...p, asset: this.asset }, await this.ctx());
    await this.custody.sign(keyOf(settlement), tx);
    return {
      xdr: tx.toEnvelope().toXDR('base64'),
      hash: txHash(tx),
      expiresAt: txExpiry(tx),
    };
  }

  submit(xdr: string): Promise<SubmitOutcome> {
    return this.ledger.submit(xdr, this.stellar.networkPassphrase);
  }

  /**
   * Settlement-sourced transactions share one sequence number, so they are
   * built and submitted one at a time across instances.
   */
  withSettlement<T>(work: () => Promise<T>): Promise<T> {
    return this.database.exclusive(SETTLEMENT_LOCK_ID, work);
  }

  async ctx(): Promise<TxContext> {
    return {
      fee: Math.max(100, await this.ledger.baseFee()),
      networkPassphrase: this.stellar.networkPassphrase,
      ttlSeconds: TX_TTL_SECONDS,
    };
  }

  /** Parses a stored XDR back, for tests and diagnostics. */
  parse(xdr: string): Transaction {
    return TransactionBuilder.fromXDR(xdr, this.stellar.networkPassphrase) as Transaction;
  }

  private async markActive(wallet: WalletRow) {
    await updateWallet(this.database.db, wallet.id, {
      status: 'active',
      activatedAt: new Date(),
      activationError: null,
    });
  }

  private async recordActivationFailure(wallet: WalletRow, error: string) {
    await updateWallet(this.database.db, wallet.id, {
      activationError: error.slice(0, 500),
      activationAttempts: wallet.activationAttempts + 1,
    });
  }
}

export const SETTLEMENT_LOCK_ID = 727_301;
