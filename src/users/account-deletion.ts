import { randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../database/database.js';
import {
  addresses,
  cartItems,
  newsletterSubscribers,
  notifications,
  orders,
  otps,
  supportTickets,
  users,
  vendorOrders,
  wishlistItems,
} from '../database/schema/index.js';
import { changeStock, linesFor, setVendorOrdersOf } from '../orders/orders.queries.js';

export const DELETED_NAME = 'Deleted customer';

/** Why a customer account cannot be deleted yet, or null. Money must not be left in flight. */
export async function deletionBlockers(tx: Tx, userId: string): Promise<string[]> {
  const [[partPaid], [escrow]] = await Promise.all([
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(orders)
      .where(and(eq(orders.customerId, userId), eq(orders.status, 'awaiting_payment'), gt(orders.paidStroops, 0n))),
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(vendorOrders)
      .innerJoin(orders, eq(orders.id, vendorOrders.orderId))
      .where(
        and(
          eq(orders.customerId, userId),
          inArray(vendorOrders.escrowStatus, ['held', 'disputed', 'released']),
        ),
      ),
  ]);
  const out: string[] = [];
  if (partPaid.n > 0) out.push(`${partPaid.n} partly paid order(s): let them expire and refund what arrived`);
  if (escrow.n > 0) out.push(`${escrow.n} order(s) with payment in escrow: wait for delivery, release or refund`);
  return out;
}

/**
 * Erases the person and keeps the records: name, email, phone, photo,
 * password, 2FA, sessions, cart, wishlist, addresses, inbox and newsletter
 * entry go; orders, payments, reviews and the audit trail stay, pointing at
 * an anonymous row. The email can be used again for a new account.
 * Returns the old avatar key so the caller can delete the file.
 */
export async function anonymiseCustomer(tx: Tx, user: { id: string; email: string; avatarKey: string | null }) {
  // Unpaid checkouts close now: their stock goes back on sale.
  const open = await tx
    .update(orders)
    .set({ status: 'cancelled', closedAt: new Date() })
    .where(and(eq(orders.customerId, user.id), eq(orders.status, 'awaiting_payment')))
    .returning({ id: orders.id });
  for (const o of open) {
    const vos = await setVendorOrdersOf(tx, o.id, { status: 'cancelled', escrowStatus: 'void' }).returning();
    for (const line of await linesFor(tx, vos.map((v) => v.id))) await changeStock(tx, line.productId, line.quantity);
  }
  const anonymous = `deleted+${user.id}@deleted.fysi.invalid`;
  await tx
    .update(users)
    .set({
      email: anonymous,
      name: DELETED_NAME,
      phone: null,
      avatarKey: null,
      // Nobody knows this password; the account cannot be signed in to again.
      passwordHash: await hash(randomBytes(32).toString('base64')),
      totpSecret: null,
      totpEnabledAt: null,
      totpLastStep: null,
      deletedAt: new Date(),
    })
    .where(eq(users.id, user.id));
  await Promise.all([
    tx.delete(cartItems).where(eq(cartItems.userId, user.id)),
    tx.delete(wishlistItems).where(eq(wishlistItems.userId, user.id)),
    tx.delete(addresses).where(eq(addresses.userId, user.id)),
    tx.delete(notifications).where(eq(notifications.userId, user.id)),
    tx.delete(otps).where(eq(otps.userId, user.id)),
    tx.delete(newsletterSubscribers).where(eq(newsletterSubscribers.email, user.email)),
    tx
      .update(supportTickets)
      .set({ email: anonymous, name: DELETED_NAME })
      .where(eq(supportTickets.userId, user.id)),
  ]);
  return { closedOrders: open.length, avatarKey: user.avatarKey };
}
