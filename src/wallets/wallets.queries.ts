import { and, asc, eq, lt } from 'drizzle-orm';
import type { Executor, Tx } from '../database/database.js';
import { wallets, type WalletKind } from '../database/schema/index.js';

export type WalletRow = typeof wallets.$inferSelect;

export const insertWallet = async (
  tx: Tx,
  values: typeof wallets.$inferInsert,
): Promise<WalletRow> =>
  (await tx.insert(wallets).values(values).returning())[0];

export const findWalletFor = async (
  db: Executor,
  userId: string,
  kind: WalletKind,
): Promise<WalletRow | undefined> =>
  (
    await db
      .select()
      .from(wallets)
      .where(and(eq(wallets.userId, userId), eq(wallets.kind, kind)))
      .limit(1)
  )[0];

export const findWallet = async (db: Executor, id: string) =>
  (await db.select().from(wallets).where(eq(wallets.id, id)).limit(1))[0];

export const findSettlement = async (db: Executor) =>
  (
    await db
      .select()
      .from(wallets)
      .where(eq(wallets.kind, 'settlement'))
      .limit(1)
  )[0];

export const lockWallet = async (tx: Tx, id: string) =>
  (await tx.select().from(wallets).where(eq(wallets.id, id)).for('update'))[0];

export const updateWallet = (
  tx: Executor,
  id: string,
  values: Partial<Omit<typeof wallets.$inferInsert, 'id'>>,
) => tx.update(wallets).set(values).where(eq(wallets.id, id));

/** Wallets whose on-chain account still has to be opened, oldest first. */
export const pendingWallets = (db: Executor, maxAttempts: number, limit: number) =>
  db
    .select()
    .from(wallets)
    .where(
      and(eq(wallets.status, 'pending'), lt(wallets.activationAttempts, maxAttempts)),
    )
    .orderBy(asc(wallets.createdAt))
    .limit(limit);
