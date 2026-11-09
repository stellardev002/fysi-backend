import { and, asc, eq } from 'drizzle-orm';
import type { Executor, Tx } from '../database/database.js';
import { cartItems } from '../database/schema/index.js';

export const listCart = (db: Executor, userId: string) =>
  db
    .select({ productId: cartItems.productId, quantity: cartItems.quantity })
    .from(cartItems)
    .where(eq(cartItems.userId, userId))
    .orderBy(asc(cartItems.createdAt));

export const upsertCartItem = (
  tx: Tx,
  userId: string,
  productId: string,
  quantity: number,
) =>
  tx
    .insert(cartItems)
    .values({ userId, productId, quantity })
    .onConflictDoUpdate({
      target: [cartItems.userId, cartItems.productId],
      set: { quantity, updatedAt: new Date() },
    });

export const deleteCartItem = (tx: Tx, userId: string, productId: string) =>
  tx
    .delete(cartItems)
    .where(and(eq(cartItems.userId, userId), eq(cartItems.productId, productId)));

export const clearCart = (tx: Tx, userId: string) =>
  tx.delete(cartItems).where(eq(cartItems.userId, userId));
