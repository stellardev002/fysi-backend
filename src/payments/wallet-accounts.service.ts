import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hash, verify } from '@node-rs/argon2';
import { recordAudit } from '../audit/audit.queries.js';
import { AuthService } from '../auth/auth.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import type { EnvVars } from '../config/env.validation.js';
import { Database } from '../database/database.js';
import { centsToStroops, formatCents, stroopsToCents } from '../products/pricing.js';
import { ProductsService } from '../products/products.service.js';
import { shortAddress } from '../stellar/address.js';
import { fromStroops, toStroops } from '../stellar/amounts.js';
import { LedgerUnavailableError, StellarLedger } from '../stellar/ledger.js';
import { StellarConfig } from '../stellar/stellar.config.js';
import { newMemo } from '../stellar/transactions.js';
import { findUserById, lockUser } from '../users/users.queries.js';
import { findWalletFor, updateWallet, type WalletRow } from '../wallets/wallets.queries.js';
import { WalletsService } from '../wallets/wallets.service.js';
import type {
  CustomerWalletDto,
  TransferViewDto,
  VendorWalletDto,
  WalletActivityDto,
  WithdrawalDto,
  WithdrawDto,
} from './dto/wallets.dto.js';
import {
  insertWithdrawal,
  listVendorPayouts,
  listWithdrawals,
  lockWithdrawal,
  pendingEscrowCents,
  updateWithdrawal,
  type WithdrawalRow,
  withdrawnLastDay,
} from './payments.queries.js';
import { TransfersService } from './transfers.service.js';

/** Customer (PRD C9) and vendor (V5–V6) wallet views and actions. */
@Injectable()
export class WalletAccountsService {
  private readonly dailyLimitCents: number;
  private readonly tier1CapCents: number;
  private readonly otpTtlMs: number;

  constructor(
    private readonly database: Database,
    private readonly wallets: WalletsService,
    private readonly ledger: StellarLedger,
    private readonly stellar: StellarConfig,
    private readonly transfers: TransfersService,
    private readonly auth: AuthService,
    private readonly products: ProductsService,
    config: ConfigService<EnvVars, true>,
  ) {
    this.dailyLimitCents = config.get('WITHDRAWAL_DAILY_LIMIT_CENTS', { infer: true });
    this.tier1CapCents = config.get('CUSTOMER_TIER1_CAP_CENTS', { infer: true });
    this.otpTtlMs = config.get('OTP_TTL_MINUTES', { infer: true }) * 60_000;
  }

  /* ---------------- customer ---------------- */

  /** Opt-in custodial wallet (PRD C9, KYC Tier 1: email + phone). */
  async createCustomerWallet(user: AuthUser, pin: string): Promise<CustomerWalletDto> {
    const pinHash = await hash(pin);
    const wallet = await this.database.transaction(async (tx) => {
      const u = await lockUser(tx, user.id, 'update');
      if (!u?.phone)
        throw new BadRequestException(
          'Add your phone number first (PATCH /auth/me): Tier 1 wallets need email and phone',
        );
      if (await findWalletFor(tx, user.id, 'customer'))
        throw new ConflictException('You already have a Fysi wallet');
      const created = await this.wallets.create(tx, 'customer', user.id, { kycTier: 1, pinHash });
      await recordAudit(tx, {
        action: 'wallet.created',
        actorId: user.id,
        resourceType: 'wallet',
        resourceId: created.id,
        metadata: { kind: 'customer', publicKey: created.publicKey },
      });
      return created;
    });
    // Opens on chain now; if the network is slow the sweeper finishes it.
    await this.wallets.activate(wallet);
    return this.customerWallet(user.id);
  }

  async customerWallet(userId: string): Promise<CustomerWalletDto> {
    const w = await findWalletFor(this.database.db, userId, 'customer');
    if (!w) throw new NotFoundException('No Fysi wallet yet');
    const [balance, activity] = await Promise.all([
      this.wallets.balance(w.publicKey).catch(() => null),
      this.activity(w.publicKey),
    ]);
    const balanceStroops = balance ?? 0n;
    const capped = (w.kycTier ?? 1) < 2;
    const asset = this.wallets.asset;
    return {
      address: w.publicKey,
      status: w.status,
      balance: fromStroops(balanceStroops),
      kycTier: w.kycTier ?? 1,
      balanceCap: capped ? this.products.price(this.tier1CapCents) : null,
      overCap: capped && balanceStroops > centsToStroops(this.tier1CapCents),
      depositUri: `web+stellar:pay?destination=${w.publicKey}&asset_code=${asset.code}&asset_issuer=${asset.issuer}`,
      activity,
    };
  }

  async changePin(user: AuthUser, password: string, newPin: string): Promise<void> {
    const u = await findUserById(this.database.db, user.id);
    if (!u || !(await verify(u.passwordHash, password)))
      throw new BadRequestException('Password is incorrect');
    const w = await findWalletFor(this.database.db, user.id, 'customer');
    if (!w) throw new NotFoundException('No Fysi wallet yet');
    await this.database.transaction(async (tx) => {
      await updateWallet(tx, w.id, { pinHash: await hash(newPin), pinFailures: 0, pinLockedUntil: null });
      await recordAudit(tx, { action: 'wallet.pin_changed', actorId: user.id, resourceType: 'wallet', resourceId: w.id });
    });
  }

  /* ---------------- vendor ---------------- */

  async vendorWallet(vendorId: string): Promise<VendorWalletDto> {
    const db = this.database.db;
    const w = await findWalletFor(db, vendorId, 'vendor');
    const [balance, pendingCents, withdrawn, payouts, withdrawals] = await Promise.all([
      w ? this.wallets.balance(w.publicKey).catch(() => null) : null,
      pendingEscrowCents(db, vendorId),
      withdrawnLastDay(db, vendorId),
      listVendorPayouts(db, vendorId, 50),
      listWithdrawals(db, vendorId, 50),
    ]);
    const availableCents = balance === null ? 0 : stroopsToCents(balance).cents;
    const history: TransferViewDto[] = [
      ...payouts.map(({ payout, orderNumber }) => ({
        ...this.transferView(payout, 'payout'),
        orderNumber,
        destination: null,
      })),
      ...withdrawals.map((wd) => this.withdrawalView(wd)),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return {
      address: w?.publicKey ?? null,
      status: w?.status ?? 'none',
      available: this.products.price(availableCents),
      pending: this.products.price(pendingCents),
      withdrawableToday: this.products.price(
        Math.max(0, Math.min(availableCents, this.dailyLimitCents - withdrawn)),
      ),
      history,
    };
  }

  /** PRD V6, step 1: checks the request and emails a confirmation code. */
  async requestWithdrawal(user: AuthUser, dto: WithdrawDto): Promise<WithdrawalDto> {
    const wallet = await this.activeVendorWallet(user.id);
    if (dto.destination === wallet.publicKey)
      throw new BadRequestException('That is this wallet');
    await this.assertWithdrawable(user.id, wallet, dto.amountCents);
    let destination;
    try {
      destination = await this.ledger.loadAccount(dto.destination);
    } catch (err) {
      if (err instanceof LedgerUnavailableError)
        throw new BadRequestException('The Stellar network could not be reached. Try again shortly');
      throw err;
    }
    if (!destination?.balances.some((b) => b.assetId === this.wallets.asset.id))
      throw new BadRequestException(
        `The destination must exist and hold a ${this.wallets.asset.code} trustline`,
      );
    // Code first: inside the resend cooldown this throws 429 and nothing is created.
    await this.auth.issueWithdrawalCode(user.id, {
      amountUsd: formatCents(dto.amountCents),
      destination: shortAddress(dto.destination),
    });
    const row = await this.database.transaction(async (tx) => {
      const created = await insertWithdrawal(tx, {
        walletId: wallet.id,
        userId: user.id,
        destination: dto.destination,
        amountCents: dto.amountCents,
        amountStroops: centsToStroops(dto.amountCents),
        memo: newMemo('WD'),
        confirmBy: new Date(Date.now() + this.otpTtlMs),
      });
      await recordAudit(tx, {
        action: 'withdrawal.requested',
        actorId: user.id,
        resourceType: 'withdrawal',
        resourceId: created.id,
        metadata: { amountCents: dto.amountCents, destination: dto.destination },
      });
      return created;
    });
    return { ...this.withdrawalView(row), confirmBy: row.confirmBy };
  }

  /**
   * PRD V6, step 2: password + emailed code, then it is sent at once. Each new
   * request emails a fresh code, so only the latest withdrawal can be confirmed.
   */
  async confirmWithdrawal(
    user: AuthUser,
    id: string,
    password: string,
    code: string,
  ): Promise<WithdrawalDto> {
    const pending = await this.database.transaction((tx) => lockWithdrawal(tx, id, user.id));
    if (!pending) throw new NotFoundException('Withdrawal not found');
    if (pending.state !== 'awaiting_confirmation')
      throw new ConflictException(`This withdrawal is already ${pending.state}`);
    if (pending.confirmBy <= new Date())
      throw new ConflictException('The confirmation time passed. Start the withdrawal again');
    if (!(await this.auth.confirmWithdrawalCode(user.id, password, code)))
      throw new BadRequestException('Password or code is incorrect');
    const wallet = await this.activeVendorWallet(user.id);
    const row = await this.database.transaction(async (tx) => {
      const locked = await lockWithdrawal(tx, id, user.id);
      if (locked?.state !== 'awaiting_confirmation')
        throw new ConflictException('This withdrawal changed in the meantime');
      await this.assertWithdrawable(user.id, wallet, locked.amountCents);
      await updateWithdrawal(tx, id, { state: 'confirmed' });
      await recordAudit(tx, {
        action: 'withdrawal.confirmed',
        actorId: user.id,
        resourceType: 'withdrawal',
        resourceId: id,
      });
      return { ...locked, state: 'confirmed' as const };
    });
    await this.transfers.withdrawal(row);
    const [fresh] = (await listWithdrawals(this.database.db, user.id, 50)).filter((w) => w.id === id);
    return this.withdrawalView(fresh ?? row);
  }

  async cancelWithdrawal(user: AuthUser, id: string): Promise<void> {
    await this.database.transaction(async (tx) => {
      const w = await lockWithdrawal(tx, id, user.id);
      if (!w) throw new NotFoundException('Withdrawal not found');
      if (w.state !== 'awaiting_confirmation')
        throw new ConflictException(`This withdrawal is already ${w.state}`);
      await updateWithdrawal(tx, id, { state: 'cancelled' });
    });
  }

  /* ---------------- helpers ---------------- */

  private async activeVendorWallet(vendorId: string): Promise<WalletRow> {
    const w = await findWalletFor(this.database.db, vendorId, 'vendor');
    if (w?.status !== 'active')
      throw new ConflictException('Your wallet is not open yet; it is created when your business is approved');
    return w;
  }

  private async assertWithdrawable(userId: string, wallet: WalletRow, cents: number) {
    const used = await withdrawnLastDay(this.database.db, userId);
    if (used + cents > this.dailyLimitCents)
      throw new BadRequestException(
        `That is over the daily withdrawal limit: $${formatCents(Math.max(0, this.dailyLimitCents - used))} left today`,
      );
    const balance = (await this.wallets.balance(wallet.publicKey)) ?? 0n;
    if (balance < centsToStroops(cents))
      throw new BadRequestException(`Not enough in your wallet: $${formatCents(stroopsToCents(balance).cents)} available`);
  }

  private async activity(address: string): Promise<WalletActivityDto[]> {
    try {
      const page = await this.ledger.paymentsFor(address, { limit: 20, order: 'desc' });
      return page.records.map((p) => ({
        direction: p.to === address ? 'in' : 'out',
        amount: fromStroops(toStroops(p.amount)),
        assetCode: p.assetId.split(':')[0],
        counterparty: p.to === address ? p.from : p.to,
        memo: p.memo,
        txHash: p.txHash,
        explorerUrl: this.stellar.transactionUrl(p.txHash),
        at: p.closedAt,
      }));
    } catch {
      return [];
    }
  }

  private transferView(
    t: { id: string; amountStroops: bigint; status: string; txHash: string | null; lastError: string | null; createdAt: Date },
    kind: 'payout' | 'withdrawal',
  ): TransferViewDto {
    return {
      id: t.id,
      kind,
      amount: fromStroops(t.amountStroops),
      orderNumber: null,
      destination: null,
      status: t.status,
      txHash: t.status === 'confirmed' ? t.txHash : null,
      explorerUrl: t.status === 'confirmed' && t.txHash ? this.stellar.transactionUrl(t.txHash) : null,
      error: t.status === 'failed' ? t.lastError : null,
      createdAt: t.createdAt,
    };
  }

  private withdrawalView(w: WithdrawalRow): TransferViewDto {
    return {
      ...this.transferView(w, 'withdrawal'),
      destination: w.destination,
      status: w.state === 'awaiting_confirmation' ? 'awaiting_confirmation' : w.status,
    };
  }
}
