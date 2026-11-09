import { and, eq, lt, lte, ne, sql } from 'drizzle-orm';
import type { Executor, Tx } from '../database/database.js';
import {
  type OtpPurpose,
  otps,
  refreshTokens,
  usedRefreshTokens,
  users,
} from '../database/schema/index.js';

export const insertRefreshToken = (
  tx: Tx,
  row: typeof refreshTokens.$inferInsert,
) => tx.insert(refreshTokens).values(row);

/** Atomic consume: of two concurrent callers only one gets the row. */
export const consumeRefreshToken = async (tx: Tx, tokenHash: string) =>
  (
    await tx
      .delete(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .returning()
  )[0];

export const markRefreshTokenUsed = (
  tx: Tx,
  row: { tokenHash: string; familyId: string },
) => tx.insert(usedRefreshTokens).values(row).onConflictDoNothing();

export const findUsedRefreshToken = async (db: Executor, tokenHash: string) =>
  (
    await db
      .select()
      .from(usedRefreshTokens)
      .where(eq(usedRefreshTokens.tokenHash, tokenHash))
      .limit(1)
  )[0];

/** A live family row is what keeps its access tokens valid; logout and reuse detection delete it. */
export const familyExists = async (db: Executor, familyId: string) =>
  (
    await db
      .select({ one: sql<number>`1` })
      .from(refreshTokens)
      .where(eq(refreshTokens.familyId, familyId))
      .limit(1)
  ).length > 0;

export const deleteFamily = (tx: Tx, familyId: string) =>
  tx.delete(refreshTokens).where(eq(refreshTokens.familyId, familyId));

export const deleteExpiredForUser = (tx: Tx, userId: string) =>
  tx
    .delete(refreshTokens)
    .where(
      and(
        eq(refreshTokens.userId, userId),
        lt(refreshTokens.expiresAt, new Date()),
      ),
    );

/** Replaces the user's code unless one was issued after `cooldownBefore`. Returns false when throttled. */
export const upsertOtp = async (
  tx: Tx,
  row: {
    userId: string;
    purpose: OtpPurpose;
    codeHash: string;
    expiresAt: Date;
  },
  cooldownBefore: Date,
): Promise<boolean> =>
  (
    await tx
      .insert(otps)
      .values(row)
      .onConflictDoUpdate({
        target: [otps.userId, otps.purpose],
        set: {
          codeHash: row.codeHash,
          expiresAt: row.expiresAt,
          attempts: 0,
          createdAt: new Date(),
        },
        setWhere: lte(otps.createdAt, cooldownBefore),
      })
      .returning({ userId: otps.userId })
  ).length > 0;

const otpKey = (userId: string, purpose: OtpPurpose) =>
  and(eq(otps.userId, userId), eq(otps.purpose, purpose));

export const lockOtp = async (tx: Tx, userId: string, purpose: OtpPurpose) =>
  (
    await tx.select().from(otps).where(otpKey(userId, purpose)).for('update')
  )[0];

export const recordOtpMiss = (tx: Tx, userId: string, purpose: OtpPurpose) =>
  tx
    .update(otps)
    .set({ attempts: sql`${otps.attempts} + 1` })
    .where(otpKey(userId, purpose));

export const deleteOtp = (tx: Tx, userId: string, purpose: OtpPurpose) =>
  tx.delete(otps).where(otpKey(userId, purpose));

export const markEmailVerified = (tx: Tx, userId: string) =>
  tx
    .update(users)
    .set({ emailVerifiedAt: new Date() })
    .where(and(eq(users.id, userId), sql`${users.emailVerifiedAt} is null`));

export const updatePasswordHash = (
  tx: Tx,
  userId: string,
  passwordHash: string,
) => tx.update(users).set({ passwordHash }).where(eq(users.id, userId));

/** Deleting a family also invalidates its access tokens. */
export const deleteFamiliesForUser = (
  tx: Tx,
  userId: string,
  exceptFamilyId?: string,
) =>
  tx
    .delete(refreshTokens)
    .where(
      and(
        eq(refreshTokens.userId, userId),
        exceptFamilyId ? ne(refreshTokens.familyId, exceptFamilyId) : undefined,
      ),
    );

export const findRefreshTokenOwner = async (tx: Tx, tokenHash: string) =>
  (
    await tx
      .select({ userId: refreshTokens.userId })
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .limit(1)
  )[0]?.userId;

export const setTotp = (
  tx: Tx,
  userId: string,
  values: Partial<
    Pick<
      typeof users.$inferInsert,
      'totpSecret' | 'totpEnabledAt' | 'totpLastStep'
    >
  >,
) => tx.update(users).set(values).where(eq(users.id, userId));
