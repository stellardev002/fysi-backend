import { and, asc, count, desc, eq, inArray, lte, ne, sql } from 'drizzle-orm';
import type { Executor, Tx } from '../database/database.js';
import {
  cartItems,
  type EscrowStatus,
  type FulfilmentStatus,
  orderLines,
  orders,
  type OrderStatus,
  payments,
  products,
  users,
  vendorOrders,
  vendors,
} from '../database/schema/index.js';
import { publiclyVisible } from '../products/visibility.js';

export type OrderRow = typeof orders.$inferSelect;
export type VendorOrderRow = typeof vendorOrders.$inferSelect;
export type OrderLineRow = typeof orderLines.$inferSelect;

/** Cart lines with the product locked for the stock check, and its vendor's terms. */
export const lockCartForCheckout = (tx: Tx, userId: string) =>
  tx
    .select({
      productId: cartItems.productId,
      quantity: cartItems.quantity,
      title: products.title,
      priceCents: products.priceCents,
      stock: products.stock,
      vendorId: products.vendorId,
      vendorName: vendors.businessName,
      foundingVendor: vendors.foundingVendor,
      approvedAt: vendors.approvedAt,
      visible: sql<boolean>`${publiclyVisible()}`,
    })
    .from(cartItems)
    .innerJoin(products, eq(products.id, cartItems.productId))
    .innerJoin(vendors, eq(vendors.userId, products.vendorId))
    .where(eq(cartItems.userId, userId))
    .orderBy(asc(cartItems.createdAt))
    .for('update', { of: products });

export const changeStock = (tx: Tx, productId: string, delta: number) =>
  tx
    .update(products)
    .set({ stock: sql`${products.stock} + ${delta}` })
    .where(eq(products.id, productId));

export const insertOrder = async (tx: Tx, values: typeof orders.$inferInsert) =>
  (await tx.insert(orders).values(values).returning())[0];

export const insertVendorOrder = async (
  tx: Tx,
  values: typeof vendorOrders.$inferInsert,
) => (await tx.insert(vendorOrders).values(values).returning())[0];

export const insertLines = (tx: Tx, values: (typeof orderLines.$inferInsert)[]) =>
  tx.insert(orderLines).values(values);

export const findOrder = async (db: Executor, id: string) =>
  (await db.select().from(orders).where(eq(orders.id, id)).limit(1))[0];

export const findOrderByNumber = async (db: Executor, number: string) =>
  (await db.select().from(orders).where(eq(orders.number, number)).limit(1))[0];

export const findOrderByPayLink = async (db: Executor, hash: string) =>
  (await db.select().from(orders).where(eq(orders.payLinkHash, hash)).limit(1))[0];

export const lockOrder = async (tx: Tx, id: string) =>
  (await tx.select().from(orders).where(eq(orders.id, id)).for('update'))[0];

export const updateOrder = (
  tx: Executor,
  id: string,
  values: Partial<Omit<typeof orders.$inferInsert, 'id'>>,
) => tx.update(orders).set(values).where(eq(orders.id, id));

export const listCustomerOrders = async (
  db: Executor,
  customerId: string,
  page: { limit: number; offset: number },
) => {
  const where = eq(orders.customerId, customerId);
  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(orders)
      .where(where)
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(page.limit)
      .offset(page.offset),
    db.select({ total: count() }).from(orders).where(where),
  ]);
  return { rows, total };
};

export const vendorOrdersFor = (db: Executor, orderIds: string[]) =>
  orderIds.length === 0
    ? Promise.resolve([])
    : db
        .select({
          vo: vendorOrders,
          vendorName: vendors.businessName,
          vendorSlug: vendors.slug,
        })
        .from(vendorOrders)
        .innerJoin(vendors, eq(vendors.userId, vendorOrders.vendorId))
        .where(inArray(vendorOrders.orderId, orderIds))
        .orderBy(asc(vendorOrders.createdAt));

export const linesFor = (db: Executor, vendorOrderIds: string[]) =>
  vendorOrderIds.length === 0
    ? Promise.resolve([])
    : db
        .select()
        .from(orderLines)
        .where(inArray(orderLines.vendorOrderId, vendorOrderIds))
        .orderBy(asc(orderLines.title));

export const paymentsForOrder = (db: Executor, orderId: string) =>
  db
    .select()
    .from(payments)
    .where(eq(payments.orderId, orderId))
    .orderBy(asc(payments.createdAt));

export const findVendorOrder = async (db: Executor, id: string) =>
  (await db.select().from(vendorOrders).where(eq(vendorOrders.id, id)).limit(1))[0];

export const lockVendorOrder = async (tx: Tx, id: string) =>
  (await tx.select().from(vendorOrders).where(eq(vendorOrders.id, id)).for('update'))[0];

export const updateVendorOrder = (
  tx: Executor,
  id: string,
  values: Partial<Omit<typeof vendorOrders.$inferInsert, 'id'>>,
) => tx.update(vendorOrders).set(values).where(eq(vendorOrders.id, id));

export const setVendorOrdersOf = (
  tx: Tx,
  orderId: string,
  values: { status?: FulfilmentStatus; escrowStatus?: EscrowStatus },
) => tx.update(vendorOrders).set(values).where(eq(vendorOrders.orderId, orderId));

/** Vendor's orders once paid (unpaid checkouts are not the vendor's business yet). */
export const listVendorOrders = async (
  db: Executor,
  vendorId: string,
  filter: { status?: FulfilmentStatus },
  page: { limit: number; offset: number },
) => {
  const where = and(
    eq(vendorOrders.vendorId, vendorId),
    ne(vendorOrders.status, 'awaiting_payment'),
    ne(vendorOrders.escrowStatus, 'void'),
    filter.status ? eq(vendorOrders.status, filter.status) : undefined,
  );
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        vo: vendorOrders,
        orderNumber: orders.number,
        paidAt: orders.paidAt,
        deliveryAddress: orders.deliveryAddress,
        customerName: users.name,
      })
      .from(vendorOrders)
      .innerJoin(orders, eq(orders.id, vendorOrders.orderId))
      .innerJoin(users, eq(users.id, orders.customerId))
      .where(where)
      .orderBy(desc(orders.paidAt), desc(vendorOrders.id))
      .limit(page.limit)
      .offset(page.offset),
    db.select({ total: count() }).from(vendorOrders).where(where),
  ]);
  return { rows, total };
};

export const findVendorOrderForVendor = async (
  db: Executor,
  vendorId: string,
  id: string,
) =>
  (
    await db
      .select({
        vo: vendorOrders,
        orderNumber: orders.number,
        paidAt: orders.paidAt,
        deliveryAddress: orders.deliveryAddress,
        customerName: users.name,
      })
      .from(vendorOrders)
      .innerJoin(orders, eq(orders.id, vendorOrders.orderId))
      .innerJoin(users, eq(users.id, orders.customerId))
      .where(
        and(
          eq(vendorOrders.id, id),
          eq(vendorOrders.vendorId, vendorId),
          ne(vendorOrders.status, 'awaiting_payment'),
          ne(vendorOrders.escrowStatus, 'void'),
        ),
      )
      .limit(1)
  )[0];

/** Open checkouts past their payment window. */
export const expiredOrders = (db: Executor, limit: number) =>
  db
    .select()
    .from(orders)
    .where(and(eq(orders.status, 'awaiting_payment'), lte(orders.expiresAt, new Date())))
    .orderBy(asc(orders.expiresAt))
    .limit(limit);

/** Escrow due for automatic release (7 days after Shipped, no dispute). */
export const dueForRelease = (db: Executor, limit: number) =>
  db
    .select()
    .from(vendorOrders)
    .where(
      and(
        eq(vendorOrders.escrowStatus, 'held'),
        lte(vendorOrders.autoReleaseAt, new Date()),
      ),
    )
    .orderBy(asc(vendorOrders.autoReleaseAt))
    .limit(limit);

export const removeFromCart = (tx: Tx, userId: string, productIds: string[]) =>
  productIds.length === 0
    ? Promise.resolve()
    : tx
        .delete(cartItems)
        .where(and(eq(cartItems.userId, userId), inArray(cartItems.productId, productIds)));

export const orderStatusIs = (status: OrderStatus) => eq(orders.status, status);
