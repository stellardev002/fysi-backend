import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';

// Row exists = an admin suspended this account. Sessions are revoked when the row is
// written and login is refused while it exists.
export const userSuspensions = pgTable('user_suspensions', {
  userId: uuid()
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  reason: text().notNull(),
  suspendedBy: uuid().notNull(),
  suspendedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}).enableRLS();
