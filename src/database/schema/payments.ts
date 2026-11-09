import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { v7 } from 'uuid';
import { orders, vendorOrders } from './orders.js';
import { users } from './users.js';
import { wallets } from './wallets.js';

/**
 * Every payment operation into the settlement account, as the watcher saw it
 * on the ledger. The operation id is unique, so replaying the ledger after
 * downtime never counts a payment twice (PRD reliability).
 *
 * matched: credited to an order. overpaid: credited, with an excess to refund.
 * unmatched: no order (wrong memo or asset, or the order had closed): refund.
 */
export const paymentStatusEnum = pgEnum('payment_status', [
  'matched',
  'overpaid',
  'unmatched',
  'refunded',
]);
export type PaymentStatus = (typeof paymentStatusEnum.enumValues)[number];

export const payments = pgTable(
  'payments',
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => v7()),
    operationId: text().notNull().unique(),
    txHash: text().notNull(),
    ledger: integer().notNull(),
    fromAddress: text().notNull(),
    // `CODE:ISSUER`, or `XLM`; only the settlement asset can match an order.
    assetId: text().notNull(),
    amountStroops: bigint({ mode: 'bigint' }).notNull(),
    memo: text(),
    orderId: uuid().references(() => orders.id, { onDelete: 'restrict' }),
    status: paymentStatusEnum().notNull(),
    // What still has to go back to the payer (overpaid excess, or everything).
    refundableStroops: bigint({ mode: 'bigint' }).notNull().default(sql`0`),
    // Why it was flagged, in plain words for the admin.
    note: text(),
    closedAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('payments_order_idx').on(t.orderId),
    index('payments_status_idx').on(t.status, t.createdAt.desc()),
    index('payments_created_idx').on(t.createdAt.desc()),
  ],
).enableRLS();

/** Platform-signed transfers: payouts, refunds and withdrawals share one lifecycle. */
export const transferStatusEnum = pgEnum('transfer_status', [
  'queued',
  'submitted',
  'confirmed',
  'failed',
]);
export type TransferStatus = (typeof transferStatusEnum.enumValues)[number];

const transferColumns = () => ({
  id: uuid()
    .primaryKey()
    .$defaultFn(() => v7()),
  destination: text().notNull(),
  amountStroops: bigint({ mode: 'bigint' }).notNull(),
  memo: text().notNull(),
  status: transferStatusEnum().notNull().default('queued'),
  // Hash of the built transaction, stored before submitting so an unknown
  // outcome is settled by looking it up, never by sending again.
  txHash: text().unique(),
  txExpiresAt: timestamp({ withTimezone: true }),
  attempts: integer().notNull().default(0),
  lastError: text(),
  confirmedAt: timestamp({ withTimezone: true }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/** Escrow released to a vendor's custodial wallet (order total minus commission). */
export const payouts = pgTable(
  'payouts',
  {
    ...transferColumns(),
    vendorOrderId: uuid()
      .notNull()
      .unique()
      .references(() => vendorOrders.id, { onDelete: 'restrict' }),
    walletId: uuid()
      .notNull()
      .references(() => wallets.id, { onDelete: 'restrict' }),
  },
  (t) => [index('payouts_status_idx').on(t.status, t.createdAt)],
).enableRLS();

/** Manual refunds by an admin (PRD decision), in USDC to the paying address. */
export const refunds = pgTable(
  'refunds',
  {
    ...transferColumns(),
    paymentId: uuid().references(() => payments.id, { onDelete: 'restrict' }),
    vendorOrderId: uuid().references(() => vendorOrders.id, {
      onDelete: 'restrict',
    }),
    reason: text().notNull(),
    requestedBy: uuid().notNull(),
  },
  (t) => [index('refunds_status_idx').on(t.status, t.createdAt)],
).enableRLS();

/**
 * Vendor withdrawals to an external Stellar address (PRD V6), confirmed with
 * password and an emailed code, within a daily limit. Until confirmed the row
 * is `awaiting_confirmation` and nothing is built.
 */
export const withdrawalStateEnum = pgEnum('withdrawal_state', [
  'awaiting_confirmation',
  'cancelled',
  'confirmed',
]);

export const withdrawals = pgTable(
  'withdrawals',
  {
    ...transferColumns(),
    walletId: uuid()
      .notNull()
      .references(() => wallets.id, { onDelete: 'restrict' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    amountCents: bigint({ mode: 'number' }).notNull(),
    state: withdrawalStateEnum().notNull().default('awaiting_confirmation'),
    confirmBy: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [index('withdrawals_user_idx').on(t.userId, t.createdAt.desc())],
).enableRLS();

/** Where the payment watcher stopped: Horizon paging tokens by stream name. */
export const chainCursors = pgTable('chain_cursors', {
  name: text().primaryKey(),
  cursor: text().notNull(),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}).enableRLS();
