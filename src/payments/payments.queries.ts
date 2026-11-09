import { and, asc, count, desc, eq, gte, inArray, ne, or, sql } from 'drizzle-orm';
import type { Executor, Tx } from '../database/database.js';
import {
  chainCursors,
  orders,
  payments,
  type PaymentStatus,
  payouts,
  refunds,
  type TransferStatus,
  users,
  vendorOrders,
  vendors,
  wallets,
  withdrawals,
} from '../database/schema/index.js';

export type PaymentRow = typeof payments.$inferSelect;
export type PayoutRow = typeof payouts.$inferSelect;
export type RefundRow = typeof refunds.$inferSelect;
export type WithdrawalRow = typeof withdrawals.$inferSelect;
export type TransferKind = 'payout' | 'refund' | 'withdrawal';

/* ---------------- watcher ---------------- */

export const getCursor = async (db: Executor, name: string) =>
  (await db.select().from(chainCursors).where(eq(chainCursors.name, name)).limit(1))[0]
    ?.cursor;

export const setCursor = (tx: Tx, name: string, cursor: string) =>
  tx
    .insert(chainCursors)
    .values({ name, cursor })
    .onConflictDoUpdate({ target: chainCursors.name, set: { cursor, updatedAt: new Date() } });

/** Undefined when the operation was already recorded (a replay). */
export const insertPayment = async (tx: Tx, values: typeof payments.$inferInsert) =>
  (await tx.insert(payments).values(values).onConflictDoNothing().returning())[0];

export const lockPayment = async (tx: Tx, id: string) =>
  (await tx.select().from(payments).where(eq(payments.id, id)).for('update'))[0];

export const updatePayment = (
  tx: Executor,
  id: string,
  values: Partial<Omit<typeof payments.$inferInsert, 'id'>>,
) => tx.update(payments).set(values).where(eq(payments.id, id));

export const paymentsOfOrder = (tx: Executor, orderId: string) =>
  tx.select().from(payments).where(eq(payments.orderId, orderId)).orderBy(asc(payments.createdAt));

/* ---------------- transfers ---------------- */

const TABLES = { payout: payouts, refund: refunds, withdrawal: withdrawals } as const;

export const updateTransfer = (
  db: Executor,
  kind: TransferKind,
  id: string,
  values: {
    status?: TransferStatus;
    txHash?: string | null;
    txExpiresAt?: Date | null;
    attempts?: number;
    lastError?: string | null;
    confirmedAt?: Date | null;
  },
) => {
  const table = TABLES[kind];
  return db.update(table).set(values).where(eq(table.id, id));
};

/** Transfers to work on: queued ones, and submitted ones whose outcome is unknown. */
export const openPayouts = (db: Executor, limit: number) =>
  db.select().from(payouts)
    .where(inArray(payouts.status, ['queued', 'submitted']))
    .orderBy(asc(payouts.createdAt)).limit(limit);

export const openRefunds = (db: Executor, limit: number) =>
  db.select().from(refunds)
    .where(inArray(refunds.status, ['queued', 'submitted']))
    .orderBy(asc(refunds.createdAt)).limit(limit);

export const openWithdrawals = (db: Executor, limit: number) =>
  db.select().from(withdrawals)
    .where(and(eq(withdrawals.state, 'confirmed'), inArray(withdrawals.status, ['queued', 'submitted'])))
    .orderBy(asc(withdrawals.createdAt)).limit(limit);

export const insertPayout = async (tx: Tx, values: typeof payouts.$inferInsert) =>
  (await tx.insert(payouts).values(values).onConflictDoNothing().returning())[0];

export const insertRefund = async (tx: Tx, values: typeof refunds.$inferInsert) =>
  (await tx.insert(refunds).values(values).returning())[0];

export const findPayoutForVendorOrder = async (db: Executor, vendorOrderId: string) =>
  (await db.select().from(payouts).where(eq(payouts.vendorOrderId, vendorOrderId)).limit(1))[0];

/** A refund for this payment that is not failed: blocks a second one. */
export const liveRefundForPayment = async (db: Executor, paymentId: string) =>
  (
    await db.select().from(refunds)
      .where(and(eq(refunds.paymentId, paymentId), ne(refunds.status, 'failed')))
      .limit(1)
  )[0];

export const liveRefundForVendorOrder = async (db: Executor, vendorOrderId: string) =>
  (
    await db.select().from(refunds)
      .where(and(eq(refunds.vendorOrderId, vendorOrderId), ne(refunds.status, 'failed')))
      .limit(1)
  )[0];

export const findTransfer = async (db: Executor, kind: TransferKind, id: string) => {
  const table = TABLES[kind];
  return (await db.select().from(table).where(eq(table.id, id)).limit(1))[0] as
    | (PayoutRow | RefundRow | WithdrawalRow)
    | undefined;
};

/* ---------------- withdrawals ---------------- */

export const insertWithdrawal = async (tx: Tx, values: typeof withdrawals.$inferInsert) =>
  (await tx.insert(withdrawals).values(values).returning())[0];

export const lockWithdrawal = async (tx: Tx, id: string, userId: string) =>
  (
    await tx.select().from(withdrawals)
      .where(and(eq(withdrawals.id, id), eq(withdrawals.userId, userId)))
      .for('update')
  )[0];

export const updateWithdrawal = (
  tx: Executor,
  id: string,
  values: Partial<Omit<typeof withdrawals.$inferInsert, 'id'>>,
) => tx.update(withdrawals).set(values).where(eq(withdrawals.id, id));

/** Cents withdrawn or on the way in the last 24 hours (daily limit). */
export const withdrawnLastDay = async (db: Executor, userId: string) =>
  Number(
    (
      await db
        .select({ total: sql<string>`coalesce(sum(${withdrawals.amountCents}), 0)` })
        .from(withdrawals)
        .where(
          and(
            eq(withdrawals.userId, userId),
            eq(withdrawals.state, 'confirmed'),
            ne(withdrawals.status, 'failed'),
            gte(withdrawals.createdAt, new Date(Date.now() - 86_400_000)),
          ),
        )
    )[0].total,
  );

export const listWithdrawals = (db: Executor, userId: string, limit: number) =>
  db.select().from(withdrawals)
    .where(and(eq(withdrawals.userId, userId), ne(withdrawals.state, 'cancelled')))
    .orderBy(desc(withdrawals.createdAt)).limit(limit);

export const listVendorPayouts = (db: Executor, vendorId: string, limit: number) =>
  db
    .select({ payout: payouts, orderNumber: orders.number })
    .from(payouts)
    .innerJoin(vendorOrders, eq(vendorOrders.id, payouts.vendorOrderId))
    .innerJoin(orders, eq(orders.id, vendorOrders.orderId))
    .where(eq(vendorOrders.vendorId, vendorId))
    .orderBy(desc(payouts.createdAt))
    .limit(limit);

/** Escrow not yet in the vendor's wallet: the "pending" balance (PRD V5). */
export const pendingEscrowCents = async (db: Executor, vendorId: string) =>
  Number(
    (
      await db
        .select({ total: sql<string>`coalesce(sum(${vendorOrders.payoutCents}), 0)` })
        .from(vendorOrders)
        .where(
          and(
            eq(vendorOrders.vendorId, vendorId),
            inArray(vendorOrders.escrowStatus, ['held', 'disputed', 'released']),
          ),
        )
    )[0].total,
  );

/* ---------------- admin ---------------- */

const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');

export const listPaymentsAdmin = async (
  db: Executor,
  f: { status?: PaymentStatus; needsRefund?: boolean; q?: string },
  page: { limit: number; offset: number },
) => {
  const q = f.q?.trim();
  const where = and(
    f.status ? eq(payments.status, f.status) : undefined,
    f.needsRefund ? sql`${payments.refundableStroops} > 0` : undefined,
    q
      ? or(
          eq(payments.txHash, q.toLowerCase()),
          eq(payments.fromAddress, q.toUpperCase()),
          sql`${payments.memo} ilike ${`%${escapeLike(q)}%`}`,
        )
      : undefined,
  );
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({ payment: payments, orderNumber: orders.number })
      .from(payments)
      .leftJoin(orders, eq(orders.id, payments.orderId))
      .where(where)
      .orderBy(desc(payments.createdAt), desc(payments.id))
      .limit(page.limit)
      .offset(page.offset),
    db.select({ total: count() }).from(payments).where(where),
  ]);
  return { rows, total };
};

export const listTransfersAdmin = async (
  db: Executor,
  kind: TransferKind,
  f: { status?: TransferStatus },
  page: { limit: number; offset: number },
) => {
  const table = TABLES[kind];
  const where = f.status ? eq(table.status, f.status) : undefined;
  const [rows, [{ total }]] = await Promise.all([
    db.select().from(table).where(where)
      .orderBy(desc(table.createdAt)).limit(page.limit).offset(page.offset),
    db.select({ total: count() }).from(table).where(where),
  ]);
  return { rows: rows as (PayoutRow | RefundRow | WithdrawalRow)[], total };
};

export const listVendorOrdersAdmin = async (
  db: Executor,
  f: { escrowStatus?: string },
  page: { limit: number; offset: number },
) => {
  const where = and(
    ne(vendorOrders.escrowStatus, 'void'),
    ne(vendorOrders.escrowStatus, 'pending'),
    f.escrowStatus ? sql`${vendorOrders.escrowStatus} = ${f.escrowStatus}` : undefined,
  );
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        vo: vendorOrders,
        orderNumber: orders.number,
        vendorName: vendors.businessName,
        customerEmail: users.email,
      })
      .from(vendorOrders)
      .innerJoin(orders, eq(orders.id, vendorOrders.orderId))
      .innerJoin(vendors, eq(vendors.userId, vendorOrders.vendorId))
      .innerJoin(users, eq(users.id, orders.customerId))
      .where(where)
      .orderBy(desc(vendorOrders.updatedAt))
      .limit(page.limit)
      .offset(page.offset),
    db.select({ total: count() }).from(vendorOrders).where(where),
  ]);
  return { rows, total };
};

export const vendorWalletOf = async (db: Executor, vendorId: string) =>
  (
    await db.select().from(wallets)
      .where(and(eq(wallets.userId, vendorId), eq(wallets.kind, 'vendor')))
      .limit(1)
  )[0];

/**
 * PRD A2 dashboard: per day or week, new vendors (approved), new customers,
 * paid orders, payment volume, and payments flagged as unmatched.
 */
export const dashboardSeries = async (
  db: Executor,
  period: 'day' | 'week',
  from: Date,
) => {
  const bucket = (col: unknown) =>
    sql<string>`to_char(date_trunc(${period}, ${col} at time zone 'utc'), 'YYYY-MM-DD')`;
  const [vendorsRows, customerRows, orderRows, unmatchedRows] = await Promise.all([
    db
      .select({ bucket: bucket(vendors.approvedAt), n: count() })
      .from(vendors)
      .where(gte(vendors.approvedAt, from))
      .groupBy(sql`1`),
    db
      .select({ bucket: bucket(users.createdAt), n: count() })
      .from(users)
      .where(and(eq(users.role, 'customer'), gte(users.createdAt, from)))
      .groupBy(sql`1`),
    db
      .select({
        bucket: bucket(orders.paidAt),
        n: count(),
        cents: sql<string>`coalesce(sum(${orders.totalCents}), 0)`,
      })
      .from(orders)
      .where(gte(orders.paidAt, from))
      .groupBy(sql`1`),
    db
      .select({ bucket: bucket(payments.createdAt), n: count() })
      .from(payments)
      .where(and(eq(payments.status, 'unmatched'), gte(payments.createdAt, from)))
      .groupBy(sql`1`),
  ]);
  return { vendorsRows, customerRows, orderRows, unmatchedRows };
};
