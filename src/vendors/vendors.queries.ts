import { and, asc, count, desc, eq, or, sql } from 'drizzle-orm';
import type { Executor, Tx } from '../database/database.js';
import {
  auditLog,
  categories,
  products,
  users,
  userSuspensions,
  vendorDocuments,
  vendors,
  type VendorStatus,
} from '../database/schema/index.js';

export type VendorRow = typeof vendors.$inferSelect;
export type VendorDocumentRow = typeof vendorDocuments.$inferSelect;

export const insertVendor = (tx: Tx, values: typeof vendors.$inferInsert) =>
  tx.insert(vendors).values(values);

export const findVendor = async (
  db: Executor,
  userId: string,
): Promise<VendorRow | undefined> =>
  (await db.select().from(vendors).where(eq(vendors.userId, userId)).limit(1))[0];

/** Row lock: serialises edits, submissions and admin decisions on one vendor. */
export const lockVendor = async (
  tx: Tx,
  userId: string,
): Promise<VendorRow | undefined> =>
  (
    await tx.select().from(vendors).where(eq(vendors.userId, userId)).for('update')
  )[0];

export const findVendorSummary = async (db: Executor, userId: string) =>
  (
    await db
      .select({
        status: vendors.status,
        businessName: vendors.businessName,
        slug: vendors.slug,
        decisionReason: vendors.decisionReason,
      })
      .from(vendors)
      .where(eq(vendors.userId, userId))
      .limit(1)
  )[0];

export const updateVendor = async (
  tx: Tx,
  userId: string,
  values: Partial<Omit<typeof vendors.$inferInsert, 'userId'>>,
): Promise<VendorRow> =>
  (
    await tx
      .update(vendors)
      .set(values)
      .where(eq(vendors.userId, userId))
      .returning()
  )[0];

export const slugTaken = async (db: Executor, slug: string) =>
  (
    await db
      .select({ one: sql<number>`1` })
      .from(vendors)
      .where(eq(vendors.slug, slug))
      .limit(1)
  ).length > 0;

export const listDocuments = (db: Executor, vendorId: string) =>
  db
    .select()
    .from(vendorDocuments)
    .where(eq(vendorDocuments.vendorId, vendorId))
    .orderBy(asc(vendorDocuments.createdAt));

export const insertDocument = async (
  tx: Tx,
  values: typeof vendorDocuments.$inferInsert,
): Promise<VendorDocumentRow> =>
  (await tx.insert(vendorDocuments).values(values).returning())[0];

export const deleteDocument = async (
  tx: Tx,
  vendorId: string,
  id: string,
): Promise<VendorDocumentRow | undefined> =>
  (
    await tx
      .delete(vendorDocuments)
      .where(
        and(eq(vendorDocuments.vendorId, vendorId), eq(vendorDocuments.id, id)),
      )
      .returning()
  )[0];

export const countDocuments = async (db: Executor, vendorId: string) =>
  (
    await db
      .select({ n: count() })
      .from(vendorDocuments)
      .where(eq(vendorDocuments.vendorId, vendorId))
  )[0].n;

const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');

/**
 * Admin queue. Pending applications come oldest first, so the 72-hour target
 * (PRD success metric) is worked in order; other statuses newest first.
 */
export const listVendorsForAdmin = async (
  db: Executor,
  filter: { status?: VendorStatus; q?: string },
  page: { limit: number; offset: number },
) => {
  const pattern = filter.q?.trim()
    ? `%${escapeLike(filter.q.trim())}%`
    : undefined;
  const where = and(
    filter.status ? eq(vendors.status, filter.status) : undefined,
    pattern
      ? or(
          sql`${vendors.businessName} ilike ${pattern}`,
          sql`${users.email} ilike ${pattern}`,
          sql`${vendors.cacNumber} ilike ${pattern}`,
        )
      : undefined,
  );
  const order =
    filter.status === 'pending'
      ? [asc(vendors.submittedAt), asc(vendors.userId)]
      : [desc(vendors.updatedAt), desc(vendors.userId)];
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: vendors.userId,
        status: vendors.status,
        businessName: vendors.businessName,
        email: users.email,
        ownerName: users.name,
        city: vendors.city,
        state: vendors.state,
        categoryName: categories.name,
        submissionCount: vendors.submissionCount,
        submittedAt: vendors.submittedAt,
        reviewedAt: vendors.reviewedAt,
        createdAt: vendors.createdAt,
      })
      .from(vendors)
      .innerJoin(users, eq(users.id, vendors.userId))
      .leftJoin(categories, eq(categories.id, vendors.categoryId))
      .where(where)
      .orderBy(...order)
      .limit(page.limit)
      .offset(page.offset),
    db
      .select({ total: count() })
      .from(vendors)
      .innerJoin(users, eq(users.id, vendors.userId))
      .where(where),
  ]);
  return { rows, total };
};

/** Decisions on one vendor, newest first, from the audit log. */
export const vendorDecisionHistory = (db: Executor, vendorId: string) =>
  db
    .select({
      action: auditLog.action,
      actorId: auditLog.actorId,
      actorName: users.name,
      metadata: auditLog.metadata,
      at: auditLog.at,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorId))
    .where(
      and(
        eq(auditLog.resourceType, 'vendor'),
        eq(auditLog.resourceId, vendorId),
      ),
    )
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(50);

/** Public storefront: an approved vendor whose account is not suspended. */
export const findPublicVendorBySlug = async (db: Executor, slug: string) =>
  (
    await db
      .select({
        vendor: vendors,
        categoryName: categories.name,
        categorySlug: categories.slug,
        productCount: sql<number>`(
          select count(*)::int from ${products}
          where ${products.vendorId} = ${vendors.userId}
            and ${products.status} = 'active'
            and ${products.moderationStatus} = 'visible'
            and ${products.deletedAt} is null
        )`,
      })
      .from(vendors)
      .leftJoin(categories, eq(categories.id, vendors.categoryId))
      .where(
        and(
          eq(vendors.slug, slug),
          eq(vendors.status, 'approved'),
          sql`not exists (select 1 from ${userSuspensions} where ${userSuspensions.userId} = ${vendors.userId})`,
        ),
      )
      .limit(1)
  )[0];
