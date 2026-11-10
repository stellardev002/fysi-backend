import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { v7 } from 'uuid';
import { orderLines } from './orders.js';
import { products } from './products.js';
import { users } from './users.js';
import { vendors } from './vendors.js';

/** `hidden`: taken down by an admin; the author still sees it with the reason. */
export const reviewStatusEnum = pgEnum('review_status', ['visible', 'hidden']);
export type ReviewStatus = (typeof reviewStatusEnum.enumValues)[number];

/**
 * Verified-purchase reviews: one per order line, once that part of the order
 * was delivered.
 */
export const productReviews = pgTable(
  'product_reviews',
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => v7()),
    orderLineId: uuid()
      .notNull()
      .unique()
      .references(() => orderLines.id, { onDelete: 'restrict' }),
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    vendorId: uuid()
      .notNull()
      .references(() => vendors.userId, { onDelete: 'restrict' }),
    customerId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    rating: smallint().notNull(),
    title: text(),
    body: text().notNull(),
    status: reviewStatusEnum().notNull().default('visible'),
    moderationReason: text(),
    moderatedBy: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check('product_reviews_rating_range', sql`${t.rating} between 1 and 5`),
    index('product_reviews_product_idx').on(t.productId, t.status, t.createdAt.desc()),
    index('product_reviews_vendor_idx').on(t.vendorId, t.createdAt.desc()),
    index('product_reviews_customer_idx').on(t.customerId, t.createdAt.desc()),
  ],
).enableRLS();
