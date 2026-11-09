import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { v7 } from 'uuid';

// Admin-managed. Deactivated rather than deleted so existing products keep theirs.
export const categories = pgTable('categories', {
  id: uuid()
    .primaryKey()
    .$defaultFn(() => v7()),
  name: text().notNull().unique(),
  slug: text().notNull().unique(),
  isActive: boolean().notNull().default(true),
  sortOrder: integer().notNull().default(0),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}).enableRLS();
