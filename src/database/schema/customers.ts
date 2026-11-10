import {
  boolean,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { v7 } from 'uuid';
import { products } from './products.js';
import { users } from './users.js';

/** Products a customer saved for later (storefront wishlist). */
export const wishlistItems = pgTable(
  'wishlist_items',
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.productId] }),
    index('wishlist_items_product_idx').on(t.productId),
  ],
).enableRLS();

/** Saved delivery addresses; checkout can use one by id. */
export const addresses = pgTable(
  'addresses',
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => v7()),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // e.g. "Home", "Office".
    label: text(),
    recipientName: text().notNull(),
    phone: text().notNull(),
    line1: text().notNull(),
    line2: text(),
    city: text().notNull(),
    state: text().notNull(),
    notes: text(),
    isDefault: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('addresses_user_idx').on(t.userId, t.createdAt),
    // At most one default per customer.
    uniqueIndex('addresses_one_default_idx')
      .on(t.userId)
      .where(sql`${t.isDefault}`),
  ],
).enableRLS();
