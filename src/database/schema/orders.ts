import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { v7 } from 'uuid';
import { products } from './products.js';
import { users } from './users.js';
import { vendors } from './vendors.js';

export interface DeliveryAddress {
  recipientName: string;
  phone: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  notes: string | null;
}

/**
 * One checkout, paid with one memo to the settlement account.
 * awaiting_payment → paid | expired | cancelled.
 */
export const orderStatusEnum = pgEnum('order_status', [
  'awaiting_payment',
  'paid',
  'expired',
  'cancelled',
]);
export type OrderStatus = (typeof orderStatusEnum.enumValues)[number];

export const orders = pgTable(
  'orders',
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => v7()),
    // Human reference and the payment memo, e.g. FY7K3M9QXW.
    number: text().notNull().unique(),
    customerId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    status: orderStatusEnum().notNull().default('awaiting_payment'),
    totalCents: bigint({ mode: 'number' }).notNull(),
    // USDC received for this order so far, in stroops.
    paidStroops: bigint({ mode: 'bigint' }).notNull().default(sql`0`),
    deliveryAddress: jsonb().$type<DeliveryAddress>().notNull(),
    // sha256 of the pay-link token (the link itself is shown once).
    payLinkHash: text().notNull().unique(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    paidAt: timestamp({ withTimezone: true }),
    closedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('orders_customer_idx').on(t.customerId, t.createdAt.desc()),
    index('orders_open_idx').on(t.status, t.expiresAt),
  ],
).enableRLS();

/** PRD V8 statuses, per vendor. */
export const fulfilmentStatusEnum = pgEnum('fulfilment_status', [
  'awaiting_payment',
  'paid',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
]);
export type FulfilmentStatus = (typeof fulfilmentStatusEnum.enumValues)[number];

/**
 * Escrow per vendor order (PRD payout decision):
 * pending (not paid yet) → held → released (payout queued) → paid_out;
 * held → disputed (problem reported) → released | refunded; held → refunded.
 */
export const escrowStatusEnum = pgEnum('escrow_status', [
  'pending',
  'held',
  'disputed',
  'released',
  'paid_out',
  'refunded',
  'void',
]);
export type EscrowStatus = (typeof escrowStatusEnum.enumValues)[number];

export const vendorOrders = pgTable(
  'vendor_orders',
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => v7()),
    orderId: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    vendorId: uuid()
      .notNull()
      .references(() => vendors.userId, { onDelete: 'restrict' }),
    status: fulfilmentStatusEnum().notNull().default('awaiting_payment'),
    subtotalCents: bigint({ mode: 'number' }).notNull(),
    // Commission fixed at checkout: 500 = 5%; 0 for founding vendors' first 3 months.
    commissionBps: integer().notNull(),
    commissionCents: bigint({ mode: 'number' }).notNull(),
    payoutCents: bigint({ mode: 'number' }).notNull(),
    escrowStatus: escrowStatusEnum().notNull().default('pending'),
    carrier: text(),
    trackingNumber: text(),
    shippedAt: timestamp({ withTimezone: true }),
    deliveredAt: timestamp({ withTimezone: true }),
    // Customer confirmed delivery (releases escrow).
    confirmedAt: timestamp({ withTimezone: true }),
    // Escrow releases automatically at this time if nothing else happens.
    autoReleaseAt: timestamp({ withTimezone: true }),
    problemReportedAt: timestamp({ withTimezone: true }),
    problemReason: text(),
    cancelledAt: timestamp({ withTimezone: true }),
    cancelReason: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('vendor_orders_order_idx').on(t.orderId),
    index('vendor_orders_vendor_idx').on(t.vendorId, t.createdAt.desc()),
    index('vendor_orders_release_idx').on(t.escrowStatus, t.autoReleaseAt),
  ],
).enableRLS();

export const orderLines = pgTable(
  'order_lines',
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => v7()),
    vendorOrderId: uuid()
      .notNull()
      .references(() => vendorOrders.id, { onDelete: 'cascade' }),
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    // Snapshot at checkout: later edits to the product do not change the order.
    title: text().notNull(),
    unitPriceCents: bigint({ mode: 'number' }).notNull(),
    // Price before a vendor promotion; null when none applied.
    listPriceCents: bigint({ mode: 'number' }),
    promotionId: uuid(),
    quantity: integer().notNull(),
  },
  (t) => [index('order_lines_vendor_order_idx').on(t.vendorOrderId)],
).enableRLS();
