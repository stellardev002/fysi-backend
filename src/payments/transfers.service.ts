import { Injectable, Logger } from '@nestjs/common';
import { recordAudit } from '../audit/audit.queries.js';
import { Database, type Tx } from '../database/database.js';
import {
  type BuiltTransfer,
  WalletsService,
} from '../wallets/wallets.service.js';
import { findWallet } from '../wallets/wallets.queries.js';
import { LedgerUnavailableError, StellarLedger } from '../stellar/ledger.js';
import { explainFailure } from '../stellar/transactions.js';
import { updateVendorOrder } from '../orders/orders.queries.js';
import {
  openPayouts,
  openRefunds,
  openWithdrawals,
  type PayoutRow,
  type RefundRow,
  type TransferKind,
  updatePayment,
  updateTransfer,
  type WithdrawalRow,
} from './payments.queries.js';

type Row = PayoutRow | RefundRow | WithdrawalRow;

const spec = (r: Row) => ({ destination: r.destination, amount: r.amountStroops, memo: r.memo });

/** Codes worth another attempt (sequence races, expiry, a wallet still opening). */
const RETRYABLE = new Set([
  'tx_bad_seq',
  'tx_too_late',
  'tx_insufficient_fee',
  'op_no_destination',
  'op_no_trust',
]);
const MAX_ATTEMPTS = 8;
/** A built transaction past its deadline cannot land; allow ledger close time. */
const SETTLE_MS = 30_000;

/**
 * Sends platform-signed USDC: payouts and refunds from the settlement account,
 * withdrawals from vendor wallets. The transaction hash is stored before it is
 * submitted, so a lost response is settled by looking the hash up, never by
 * sending a second time.
 */
@Injectable()
export class TransfersService {
  private readonly logger = new Logger(TransfersService.name);

  constructor(
    private readonly database: Database,
    private readonly wallets: WalletsService,
    private readonly ledger: StellarLedger,
  ) {}

  async processAll(): Promise<number> {
    let done = 0;
    const db = this.database.db;
    for (const p of await openPayouts(db, 20)) if (await this.payout(p)) done++;
    for (const r of await openRefunds(db, 20)) if (await this.refund(r)) done++;
    for (const w of await openWithdrawals(db, 20)) if (await this.withdrawal(w)) done++;
    return done;
  }

  payout(row: PayoutRow): Promise<boolean> {
    return this.run('payout', row, true, () =>
      this.wallets.buildFromSettlement(spec(row)),
      async (tx) => {
        await updateVendorOrder(tx, row.vendorOrderId, { escrowStatus: 'paid_out' });
      },
    );
  }

  refund(row: RefundRow): Promise<boolean> {
    return this.run('refund', row, true, () =>
      this.wallets.buildFromSettlement(spec(row)),
      async (tx) => {
        if (row.paymentId)
          await updatePayment(tx, row.paymentId, { status: 'refunded', refundableStroops: 0n });
      },
    );
  }

  withdrawal(row: WithdrawalRow): Promise<boolean> {
    return this.run('withdrawal', row, false, async () => {
      const wallet = await findWallet(this.database.db, row.walletId);
      if (!wallet) throw new Error('Wallet not found');
      return this.wallets.buildFromCustodial(wallet, spec(row));
    }, () => Promise.resolve());
  }

  /** True when the transfer reached a final state on this call. */
  private async run(
    kind: TransferKind,
    row: Row,
    viaSettlement: boolean,
    build: () => Promise<BuiltTransfer>,
    onConfirmed: (tx: Tx) => Promise<void>,
  ): Promise<boolean> {
    const db = this.database.db;
    const confirm = () =>
      this.database.transaction(async (tx) => {
        await updateTransfer(tx, kind, row.id, { status: 'confirmed', confirmedAt: new Date(), lastError: null });
        await onConfirmed(tx);
        await recordAudit(tx, {
          action: `${kind}.confirmed`,
          actorId: null,
          resourceType: kind,
          resourceId: row.id,
          metadata: { txHash: row.txHash },
        });
      });

    // Set once a transaction may have reached the network: from then on its
    // fate is only ever settled by looking the hash up, never by rebuilding.
    let submittedHash: string | null = null;
    try {
      if (row.status === 'submitted' && row.txHash) {
        const found = await this.ledger.findTransaction(row.txHash);
        if (found.found) {
          if (found.successful) {
            await confirm();
            return true;
          }
          await updateTransfer(db, kind, row.id, {
            status: 'failed',
            lastError: 'The transaction failed on the network',
          });
          return true;
        }
        if (row.txExpiresAt && Date.now() > row.txExpiresAt.getTime() + SETTLE_MS)
          // Never landed and never can: build a fresh one next time.
          await updateTransfer(db, kind, row.id, { status: 'queued', txHash: null, txExpiresAt: null });
        return false;
      }

      const work = async (): Promise<boolean> => {
        const built = await build();
        submittedHash = built.hash;
        row.txHash = built.hash;
        await updateTransfer(db, kind, row.id, {
          status: 'submitted',
          txHash: built.hash,
          txExpiresAt: built.expiresAt,
          attempts: row.attempts + 1,
        });
        let outcome;
        try {
          outcome = await this.wallets.submit(built.xdr);
        } catch (err) {
          if (err instanceof LedgerUnavailableError) return false; // Looked up next pass.
          throw err;
        }
        if (outcome.kind === 'success') {
          await confirm();
          return true;
        }
        const retry =
          outcome.codes.some((c) => RETRYABLE.has(c)) && row.attempts + 1 < MAX_ATTEMPTS;
        await updateTransfer(db, kind, row.id, {
          status: retry ? 'queued' : 'failed',
          txHash: null,
          txExpiresAt: null,
          lastError: explainFailure(outcome.codes, this.wallets.asset.code),
        });
        return !retry;
      };
      return viaSettlement ? await this.wallets.withSettlement(work) : await work();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (submittedHash) {
        await updateTransfer(db, kind, row.id, { lastError: message.slice(0, 500) });
        this.logger.error({ err, kind, id: row.id }, 'Transfer outcome unknown; will look it up');
        return false;
      }
      const final = row.attempts + 1 >= MAX_ATTEMPTS;
      await updateTransfer(db, kind, row.id, {
        status: final ? 'failed' : 'queued',
        txHash: null,
        attempts: row.attempts + 1,
        lastError: message.slice(0, 500),
      });
      this.logger.warn({ err, kind, id: row.id }, 'Transfer attempt failed');
      return final;
    }
  }
}
