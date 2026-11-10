import { Injectable, Logger } from '@nestjs/common';
import { Database } from '../database/database.js';
import { MailService } from '../mail/mail.service.js';
import {
  findOrder,
  linesFor,
  vendorOrdersFor,
} from '../orders/orders.queries.js';
import { formatCents } from '../products/pricing.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { StellarConfig } from '../stellar/stellar.config.js';
import { findUserById } from '../users/users.queries.js';
import { paymentsOfOrder } from './payments.queries.js';

/** Emails after an order is paid: the customer (PRD C7) and each vendor (V9). Never blocks payment handling. */
@Injectable()
export class OrderNotifier {
  private readonly logger = new Logger(OrderNotifier.name);

  constructor(
    private readonly database: Database,
    private readonly mail: MailService,
    private readonly stellar: StellarConfig,
    private readonly notifications: NotificationsService,
  ) {}

  async orderPaid(orderId: string): Promise<void> {
    try {
      const db = this.database.db;
      const order = await findOrder(db, orderId);
      if (!order) return;
      const [customer, vos, pays] = await Promise.all([
        findUserById(db, order.customerId),
        vendorOrdersFor(db, [orderId]),
        paymentsOfOrder(db, orderId),
      ]);
      const lines = await linesFor(db, vos.map((v) => v.vo.id));
      const describe = (voId?: string) =>
        lines
          .filter((l) => !voId || l.vendorOrderId === voId)
          .map((l) => `${l.title} × ${l.quantity} — $${formatCents(l.unitPriceCents * l.quantity)}`);
      const last = pays.at(-1);
      await this.notifications.notifyLater(order.customerId, {
        kind: 'order.paid',
        title: `Order ${order.number} is paid`,
        body: `We received $${formatCents(order.totalCents)} in USDC. Your vendors have been told.`,
        link: `/account/orders/${order.id}`,
        data: { orderId: order.id },
      });
      for (const { vo } of vos)
        await this.notifications.notifyLater(vo.vendorId, {
          kind: 'order.new',
          title: `New paid order ${order.number}`,
          body: `$${formatCents(vo.payoutCents)} after commission, held in escrow until delivery.`,
          link: `/vendor/orders/${vo.id}`,
          data: { vendorOrderId: vo.id },
        });
      if (customer && last)
        await this.mail.sendOrderConfirmation(customer.email, {
          number: order.number,
          totalUsd: formatCents(order.totalCents),
          lines: describe(),
          txHash: last.txHash,
          explorerUrl: this.stellar.transactionUrl(last.txHash),
        });
      for (const { vo } of vos) {
        const vendor = await findUserById(db, vo.vendorId);
        if (vendor)
          await this.mail.sendVendorNewOrder(vendor.email, {
            number: order.number,
            payoutUsd: formatCents(vo.payoutCents),
            lines: describe(vo.id),
          });
      }
    } catch (err) {
      this.logger.error({ err, orderId }, 'Failed to send order emails');
    }
  }
}
