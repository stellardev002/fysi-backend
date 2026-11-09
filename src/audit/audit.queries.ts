import { and, count, desc, eq, type SQL, sql } from 'drizzle-orm';
import { getRequestContext } from '../common/request-context.js';
import type { Executor, Tx } from '../database/database.js';
import { auditLog } from '../database/schema/index.js';

export interface AuditEvent {
  action: string;
  actorId?: string | null;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  /** The record before the change, for decisions an admin may need to review later. */
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

/** Requires a Tx so the audit row commits or rolls back with the change it describes. */
export const recordAudit = async (tx: Tx, event: AuditEvent): Promise<void> => {
  const ctx = getRequestContext();
  await tx.insert(auditLog).values({
    action: event.action,
    actorId: event.actorId ?? ctx?.userId ?? null,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    metadata: event.metadata,
    before: event.before,
    after: event.after,
    requestId: ctx?.requestId,
    traceId: ctx?.traceId,
    ip: ctx?.ip,
  });
};

export interface AuditFilter {
  action?: string;
  actorId?: string;
  resourceType?: string;
  resourceId?: string;
  /** First word of the action, e.g. `user` for `user.suspended`. */
  category?: string;
  from?: string;
  to?: string;
}

export const auditWhere = (filter: AuditFilter) => {
  const conditions: SQL[] = [];
  if (filter.action) conditions.push(eq(auditLog.action, filter.action));
  if (filter.actorId) conditions.push(eq(auditLog.actorId, filter.actorId));
  if (filter.resourceType)
    conditions.push(eq(auditLog.resourceType, filter.resourceType));
  if (filter.resourceId)
    conditions.push(eq(auditLog.resourceId, filter.resourceId));
  if (filter.category)
    conditions.push(
      sql`split_part(${auditLog.action}, '.', 1) = ${filter.category}`,
    );
  if (filter.from)
    conditions.push(
      sql`(${auditLog.at} at time zone 'utc')::date >= ${filter.from}::date`,
    );
  if (filter.to)
    conditions.push(
      sql`(${auditLog.at} at time zone 'utc')::date <= ${filter.to}::date`,
    );
  return conditions.length > 0 ? and(...conditions) : undefined;
};

export const listAudit = async (
  db: Executor,
  filter: AuditFilter,
  page: { limit: number; offset: number },
) => {
  const where = auditWhere(filter);
  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.at), desc(auditLog.id))
      .limit(page.limit)
      .offset(page.offset),
    db.select({ total: count() }).from(auditLog).where(where),
  ]);
  return { rows, total };
};
