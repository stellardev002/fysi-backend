import {
  bigint,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

// Append-only. A DB trigger rejects UPDATE, DELETE and TRUNCATE.
// actorId has no FK so history survives user deletion; null = anonymous.
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    actorId: uuid(),
    action: text().notNull(),
    resourceType: text(),
    resourceId: text(),
    requestId: text(),
    traceId: text(),
    ip: text(),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    // State of the record before and after the change, for admin decisions.
    before: jsonb().$type<Record<string, unknown>>(),
    after: jsonb().$type<Record<string, unknown>>(),
  },
  (t) => [
    index('audit_log_at_idx').on(t.at.desc()),
    index('audit_log_actor_idx').on(t.actorId, t.at.desc()),
    index('audit_log_action_idx').on(t.action, t.at.desc()),
    index('audit_log_resource_idx').on(
      t.resourceType,
      t.resourceId,
      t.at.desc(),
    ),
  ],
).enableRLS();
