import {
  and,
  count,
  countDistinct,
  desc,
  eq,
  gt,
  isNull,
  max,
  notExists,
  or,
  sql,
} from 'drizzle-orm';
import type { Executor, Tx } from '../database/database.js';
import {
  auditLog,
  refreshTokens,
  userSuspensions,
  users,
  type Role,
} from '../database/schema/index.js';

export type UserRow = typeof users.$inferSelect;

export const findUserByEmail = async (
  db: Executor,
  email: string,
): Promise<UserRow | undefined> =>
  (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];

export const findUserById = async (
  db: Executor,
  id: string,
): Promise<UserRow | undefined> =>
  (await db.select().from(users).where(eq(users.id, id)).limit(1))[0];

/** Row exists = suspended. Callers that issue sessions check this after taking the user lock. */
export const findSuspension = async (db: Executor, userId: string) =>
  (
    await db
      .select()
      .from(userSuspensions)
      .where(eq(userSuspensions.userId, userId))
      .limit(1)
  )[0];

export const isSuspended = async (
  db: Executor,
  userId: string,
): Promise<boolean> => (await findSuspension(db, userId)) !== undefined;

export const insertUser = async (
  tx: Tx,
  values: typeof users.$inferInsert,
): Promise<UserRow> => (await tx.insert(users).values(values).returning())[0];

export const updateUser = (
  tx: Tx,
  userId: string,
  values: Partial<Pick<UserRow, 'name' | 'avatarKey' | 'phone'>>,
) => tx.update(users).set(values).where(eq(users.id, userId));

/**
 * Serialises session issuing against session revoking for one user.
 * Revokers take 'update', issuers take 'share'. Lock order: user, otps, refresh_tokens.
 */
export const lockUser = async (
  tx: Tx,
  userId: string,
  mode: 'update' | 'share',
): Promise<UserRow | undefined> =>
  (await tx.select().from(users).where(eq(users.id, userId)).for(mode))[0];

/**
 * Frees an email held by an account that never verified, so a squatter cannot
 * block the real owner. Verified accounts are never touched; a concurrent
 * verification wins because the delete re-checks the predicate after the row lock.
 */
export const deleteUnverifiedHolder = async (
  tx: Tx,
  email: string,
): Promise<string[]> =>
  (
    await tx
      .delete(users)
      .where(
        and(
          isNull(users.emailVerifiedAt),
          eq(users.email, email),
          notExists(
            sql`(select 1 from ${userSuspensions} where ${userSuspensions.userId} = ${users.id})`,
          ),
        ),
      )
      .returning({ id: users.id })
  ).map((r) => r.id);

export const insertSuspension = (
  tx: Tx,
  values: typeof userSuspensions.$inferInsert,
) => tx.insert(userSuspensions).values(values).onConflictDoNothing();

export const deleteSuspension = async (tx: Tx, userId: string) =>
  (
    await tx
      .delete(userSuspensions)
      .where(eq(userSuspensions.userId, userId))
      .returning()
  )[0];

const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');

export const listUsers = async (
  db: Executor,
  filter: {
    q?: string;
    role?: Role;
    suspended?: boolean;
    emailVerified?: boolean;
  },
  page: { limit: number; offset: number },
) => {
  const term = filter.q?.trim();
  const pattern = term ? `%${escapeLike(term)}%` : undefined;
  const where = and(
    filter.role ? eq(users.role, filter.role) : undefined,
    pattern
      ? or(
          sql`${users.name} ilike ${pattern}`,
          sql`${users.email} ilike ${pattern}`,
        )
      : undefined,
    filter.suspended === undefined
      ? undefined
      : filter.suspended
        ? sql`${userSuspensions.userId} is not null`
        : sql`${userSuspensions.userId} is null`,
    filter.emailVerified === undefined
      ? undefined
      : filter.emailVerified
        ? sql`${users.emailVerifiedAt} is not null`
        : sql`${users.emailVerifiedAt} is null`,
  );
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: users.id,
        email: users.email,
        role: users.role,
        name: users.name,
        avatarKey: users.avatarKey,
        emailVerified: sql<boolean>`${users.emailVerifiedAt} is not null`,
        suspended: sql<boolean>`${userSuspensions.userId} is not null`,
        createdAt: users.createdAt,
      })
      .from(users)
      .leftJoin(userSuspensions, eq(userSuspensions.userId, users.id))
      .where(where)
      .orderBy(desc(users.createdAt), desc(users.id))
      .limit(page.limit)
      .offset(page.offset),
    db
      .select({ total: count() })
      .from(users)
      .leftJoin(userSuspensions, eq(userSuspensions.userId, users.id))
      .where(where),
  ]);
  return { rows, total };
};

/** Admin view of an account: last sign-in and live sessions. */
export const userActivity = async (db: Executor, userId: string) => {
  const [[login], [sessions]] = await Promise.all([
    db
      .select({ at: max(auditLog.at) })
      .from(auditLog)
      .where(
        and(eq(auditLog.actorId, userId), eq(auditLog.action, 'auth.login')),
      ),
    db
      .select({ n: countDistinct(refreshTokens.familyId) })
      .from(refreshTokens)
      .where(
        and(
          eq(refreshTokens.userId, userId),
          gt(refreshTokens.expiresAt, new Date()),
        ),
      ),
  ]);
  return {
    lastLoginAt: login?.at ?? null,
    activeSessions: sessions?.n ?? 0,
  };
};

export const userName = async (db: Executor, userId: string) =>
  (
    await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
  )[0]?.name ?? null;
