import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { recordAudit } from '../audit/audit.queries.js';
import { Database, type Tx } from '../database/database.js';
import {
  changeStock,
  dueForRelease,
  expiredOrders,
  linesFor,
  lockOrder,
  lockVendorOrder,
  setVendorOrdersOf,
  updateOrder,
  updateVendorOrder,
  type VendorOrderRow,
} from '../orders/orders.queries.js';
import { REFUNDABLE } from '../orders/rules.js';
import { centsToStroops } from '../products/pricing.js';
import { newMemo } from '../stellar/transactions.js';
import {
  insertPayout,
  insertRefund,
  liveRefundForPayment,
  liveRefundForVendorOrder,
  lockPayment,
  paymentsOfOrder,
  updatePayment,
  vendorWalletOf,
} from './payments.queries.js';

/**
 * Escrow (PRD payout decision): funds stay in the settlement account until
 * the customer confirms delivery, or 7 days after Shipped, then the vendor's
 * share is paid to their custodial wallet. Refunds are manual, by an admin,
 * to the paying address.
 */
@Injectable()
export class EscrowService {
  private readonly logger = new Logger(EscrowService.name);

  constructor(private readonly database: Database) {}

  /** Releases escrow and queues the payout. `from` lists the escrow states allowed. */
  async release(
    tx: Tx,
    vo: VendorOrderRow,
    actor: string | null,
    reason: string,
    from: readonly string[] = ['held'],
  ): Promise<void> {
    if (!from.includes(vo.escrowStatus))
      throw new ConflictException(`Escrow is ${vo.escrowStatus}; it cannot be released`);
    const wallet = await vendorWalletOf(tx, vo.vendorId);
    if (!wallet)
      throw new ConflictException('The vendor has no wallet yet; it is created on approval');
    await updateVendorOrder(tx, vo.id, { escrowStatus: 'released' });
    await insertPayout(tx, {
      vendorOrderId: vo.id,
      walletId: wallet.id,
      destination: wallet.publicKey,
      amountStroops: centsToStroops(vo.payoutCents),
      memo: newMemo('PO'),
    });
    await recordAudit(tx, {
      action: 'escrow.released',
      actorId: actor,
      resourceType: 'vendor_order',
      resourceId: vo.id,
      metadata: { reason, payoutCents: vo.payoutCents },
    });
  }

  /** Admin: resolve a dispute (or a held order) in the vendor's favour. */
  async adminRelease(adminId: string, voId: string, note: string) {
    await this.database.transaction(async (tx) => {
      const vo = await lockVendorOrder(tx, voId);
      if (!vo) throw new NotFoundException('Vendor order not found');
      await this.release(tx, vo, adminId, note, ['held', 'disputed']);
    });
  }

  /** Admin: cancels a paid vendor order before payout and refunds the customer. */
  async refundVendorOrder(adminId: string, voId: string, reason: string) {
    await this.database.transaction(async (tx) => {
      const vo = await lockVendorOrder(tx, voId);
      if (!vo) throw new NotFoundException('Vendor order not found');
      await this.refund(tx, vo, adminId, reason, false);
    });
  }

  /**
   * Cancels a paid vendor order before payout and refunds its full subtotal
   * (commission included) to the address that paid. `restock` puts the items
   * back on sale (a vendor cancelling before shipping).
   */
  async refund(tx: Tx, vo: VendorOrderRow, actorId: string, reason: string, restock: boolean) {
    if (!REFUNDABLE.includes(vo.escrowStatus))
      throw new ConflictException(
        vo.escrowStatus === 'released' || vo.escrowStatus === 'paid_out'
          ? 'The vendor was already paid; refund this one by hand'
          : `Escrow is ${vo.escrowStatus}; nothing to refund`,
      );
    if (await liveRefundForVendorOrder(tx, vo.id))
      throw new ConflictException('A refund for this order is already on its way');
    const payer = (await paymentsOfOrder(tx, vo.orderId)).find((p) => p.status !== 'unmatched');
    if (!payer) throw new ConflictException('No payment found for this order');
    await insertRefund(tx, {
      vendorOrderId: vo.id,
      destination: payer.fromAddress,
      amountStroops: centsToStroops(vo.subtotalCents),
      memo: newMemo('RF'),
      reason,
      requestedBy: actorId,
    });
    await updateVendorOrder(tx, vo.id, {
      status: 'cancelled',
      escrowStatus: 'refunded',
      cancelledAt: new Date(),
      cancelReason: reason,
    });
    if (restock)
      for (const line of await linesFor(tx, [vo.id])) await changeStock(tx, line.productId, line.quantity);
    await recordAudit(tx, {
      action: 'vendor_order.refunded',
      actorId,
      resourceType: 'vendor_order',
      resourceId: vo.id,
      metadata: { reason, cents: vo.subtotalCents, destination: payer.fromAddress, restock },
    });
  }

  /** Admin: returns an unmatched payment, or the excess of an overpaid one. */
  async refundPayment(adminId: string, paymentId: string, reason: string) {
    await this.database.transaction(async (tx) => {
      const p = await lockPayment(tx, paymentId);
      if (!p) throw new NotFoundException('Payment not found');
      if (p.refundableStroops <= 0n)
        throw new BadRequestException('Nothing on this payment is due back');
      if (await liveRefundForPayment(tx, paymentId))
        throw new ConflictException('A refund for this payment is already on its way');
      await insertRefund(tx, {
        paymentId: p.id,
        destination: p.fromAddress,
        amountStroops: p.refundableStroops,
        memo: newMemo('RF'),
        reason,
        requestedBy: adminId,
      });
      await recordAudit(tx, {
        action: 'payment.refund_requested',
        actorId: adminId,
        resourceType: 'payment',
        resourceId: p.id,
        metadata: { reason, stroops: p.refundableStroops.toString() },
      });
    });
  }

  /**
   * Sweeper: closes checkouts whose window passed. Stock goes back; anything
   * received for a partly paid order is flagged for refund.
   */
  async expireOrders(): Promise<number> {
    let n = 0;
    for (const candidate of await expiredOrders(this.database.db, 50)) {
      const expired = await this.database.transaction(async (tx) => {
        const order = await lockOrder(tx, candidate.id);
        if (order?.status !== 'awaiting_payment' || order.expiresAt > new Date()) return false;
        await this.closeUnpaid(tx, order.id, order.paidStroops > 0n);
        await updateOrder(tx, order.id, { status: 'expired', closedAt: new Date() });
        await recordAudit(tx, {
          action: 'order.expired',
          actorId: null,
          resourceType: 'order',
          resourceId: order.id,
          metadata: { paidStroops: order.paidStroops.toString() },
        });
        return true;
      });
      if (expired) n++;
    }
    return n;
  }

  /** Puts stock back and voids escrow for an order that was never fully paid. */
  async closeUnpaid(tx: Tx, orderId: string, refundReceived: boolean) {
    const vos = await setVendorOrdersOf(tx, orderId, {
      status: 'cancelled',
      escrowStatus: 'void',
    }).returning();
    for (const line of await linesFor(tx, vos.map((v) => v.id)))
      await changeStock(tx, line.productId, line.quantity);
    if (refundReceived)
      for (const p of await paymentsOfOrder(tx, orderId))
        await updatePayment(tx, p.id, {
          status: 'unmatched',
          refundableStroops: p.amountStroops,
          note: 'The order expired before it was fully paid: refund what arrived',
        });
  }

  /** Sweeper: releases escrow 7 days after Shipped when nothing else happened. */
  async autoRelease(): Promise<number> {
    let n = 0;
    for (const candidate of await dueForRelease(this.database.db, 50)) {
      try {
        await this.database.transaction(async (tx) => {
          const vo = await lockVendorOrder(tx, candidate.id);
          if (vo?.escrowStatus !== 'held' || !vo.autoReleaseAt || vo.autoReleaseAt > new Date())
            return;
          await this.release(tx, vo, null, 'Automatic release after shipping');
          n++;
        });
      } catch (err) {
        this.logger.warn({ err, vendorOrderId: candidate.id }, 'Auto-release skipped');
      }
    }
    return n;
  }
}
