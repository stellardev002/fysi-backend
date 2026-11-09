import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { recordAudit } from '../audit/audit.queries.js';
import type { EnvVars } from '../config/env.validation.js';
import { Database, type Tx } from '../database/database.js';
import { applyPayment } from '../orders/rules.js';
import {
  findOrderByNumber,
  lockOrder,
  removeFromCart,
  setVendorOrdersOf,
  updateOrder,
  vendorOrdersFor,
  linesFor,
} from '../orders/orders.queries.js';
import { toStroops } from '../stellar/amounts.js';
import { type LedgerPayment, StellarLedger } from '../stellar/ledger.js';
import { StellarConfig } from '../stellar/stellar.config.js';
import { findSettlement } from '../wallets/wallets.queries.js';
import { OrderNotifier } from './order-notifier.js';
import { getCursor, insertPayment, setCursor } from './payments.queries.js';

const WATCHER_LOCK_ID = 727_302;
const CURSOR = 'settlement_payments';
const PAGE = 100;

/**
 * Reads every payment into the settlement account from the ledger and applies
 * it to its order by memo (PRD payment rule 2). The Horizon paging token is
 * stored with each payment in the same transaction, so after downtime it
 * replays from where it stopped, and the unique operation id means no payment
 * is ever counted twice (PRD reliability).
 */
@Injectable()
export class PaymentWatcher {
  private readonly logger = new Logger(PaymentWatcher.name);
  private readonly graceMs: number;
  private inFlight: Promise<number> | null = null;

  constructor(
    private readonly database: Database,
    private readonly ledger: StellarLedger,
    private readonly stellar: StellarConfig,
    private readonly notifier: OrderNotifier,
    config: ConfigService<EnvVars, true>,
  ) {
    this.graceMs = config.get('PARTIAL_PAYMENT_GRACE_HOURS', { infer: true }) * 3_600_000;
  }

  /** One pass; concurrent callers in this process share it, then run once more. */
  async sync(): Promise<number> {
    if (this.inFlight) await this.inFlight.catch(() => 0);
    this.inFlight = this.pass();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async pass(): Promise<number> {
    const settlement = await findSettlement(this.database.db);
    if (settlement?.status !== 'active') return 0;
    const paidOrders: string[] = [];
    const seen = await this.database.exclusive(WATCHER_LOCK_ID, async () => {
      let cursor = await getCursor(this.database.db, CURSOR);
      let count = 0;
      for (;;) {
        const page = await this.ledger.paymentsFor(settlement.publicKey, {
          cursor,
          limit: PAGE,
        });
        for (const record of page.records) {
          const paid = await this.database.transaction(async (tx) => {
            const result =
              record.to === settlement.publicKey ? await this.record(tx, record) : null;
            await setCursor(tx, CURSOR, record.pagingToken);
            return result;
          });
          if (paid) paidOrders.push(paid);
          count++;
        }
        if (!page.cursor || page.cursor === cursor) break;
        // Skip past trailing non-payment operations too.
        await this.database.transaction((tx) => setCursor(tx, CURSOR, page.cursor!));
        cursor = page.cursor;
      }
      return count;
    });
    for (const orderId of paidOrders) void this.notifier.orderPaid(orderId);
    return seen;
  }

  /** Applies one incoming payment. Returns the order id when it became paid. */
  private async record(tx: Tx, p: LedgerPayment): Promise<string | null> {
    const amount = toStroops(p.amount);
    const base = {
      operationId: p.id,
      txHash: p.txHash,
      ledger: p.ledger,
      fromAddress: p.from,
      assetId: p.assetId,
      amountStroops: amount,
      memo: p.memo,
      closedAt: p.closedAt,
    };
    const usdc = p.assetId === this.stellar.settlementAsset.id;
    const memo = p.memo?.trim().toUpperCase() ?? '';
    const found = memo ? await findOrderByNumber(tx, memo) : undefined;
    const order = found ? await lockOrder(tx, found.id) : undefined;

    if (!usdc || !order) {
      const inserted = await insertPayment(tx, {
        ...base,
        orderId: order?.id ?? null,
        status: 'unmatched',
        refundableStroops: usdc ? amount : 0n,
        note: !usdc
          ? `Paid in ${p.assetId.split(':')[0]}, not ${this.stellar.settlementAsset.code}: return it by hand`
          : memo
            ? `No order has the memo "${p.memo}"`
            : 'The payment has no memo',
      });
      if (inserted) await this.audit(tx, inserted.id, 'payment.unmatched', order?.id);
      return null;
    }

    const effect = applyPayment(order, amount);
    if (effect.kind === 'closed') {
      const inserted = await insertPayment(tx, {
        ...base,
        orderId: order.id,
        status: 'unmatched',
        refundableStroops: amount,
        note: `Order ${order.number} was already ${order.status.replace('_', ' ')} when this arrived`,
      });
      if (inserted) await this.audit(tx, inserted.id, 'payment.unmatched', order.id);
      return null;
    }

    const inserted = await insertPayment(tx, {
      ...base,
      orderId: order.id,
      status: effect.kind === 'paid' && effect.excess > 0n ? 'overpaid' : 'matched',
      refundableStroops: effect.kind === 'paid' ? effect.excess : 0n,
      note:
        effect.kind === 'paid' && effect.excess > 0n
          ? 'Paid more than the order total: refund the excess'
          : null,
    });
    if (!inserted) return null; // Already applied on an earlier pass.
    const paidStroops = order.paidStroops + amount;

    if (effect.kind === 'partial') {
      // Underpaid: the order stays open for the balance (PRD rule 3).
      await updateOrder(tx, order.id, {
        paidStroops,
        expiresAt:
          order.paidStroops === 0n
            ? new Date(Math.max(order.expiresAt.getTime(), Date.now() + this.graceMs))
            : order.expiresAt,
      });
      await this.audit(tx, inserted.id, 'payment.partial', order.id);
      return null;
    }

    const now = new Date();
    await updateOrder(tx, order.id, { paidStroops, status: 'paid', paidAt: now, closedAt: now });
    await setVendorOrdersOf(tx, order.id, { status: 'paid', escrowStatus: 'held' });
    const vos = await vendorOrdersFor(tx, [order.id]);
    const lines = await linesFor(tx, vos.map((v) => v.vo.id));
    await removeFromCart(tx, order.customerId, lines.map((l) => l.productId));
    await this.audit(tx, inserted.id, 'order.paid', order.id);
    this.logger.log({ orderId: order.id, number: order.number }, 'Order paid');
    return order.id;
  }

  private audit(tx: Tx, paymentId: string, action: string, orderId?: string) {
    return recordAudit(tx, {
      action,
      actorId: null,
      resourceType: 'payment',
      resourceId: paymentId,
      metadata: { orderId: orderId ?? null },
    });
  }
}
