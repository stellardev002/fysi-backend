import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { v7 } from 'uuid';
import { products } from './products.js';
import { vendors } from './vendors.js';

/** `paused`: switched off by the vendor; `ended` is final. */
export const promotionStatusEnum = pgEnum('promotion_status', [
  'active',
  'paused',
  'ended',
]);
export type PromotionStatus = (typeof promotionStatusEnum.enumValues)[number];

/**
 * Vendor sale: a percentage off chosen products (or the whole store) between
 * two dates. Prices drop automatically, with no code; when several apply, the
 * biggest discount wins (they never stack).
 */
export const promotions = pgTable(
  'promotions',
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => v7()),
    vendorId: uuid()
      .notNull()
      .references(() => vendors.userId, { onDelete: 'cascade' }),
    name: text().notNull(),
    // 1500 = 15% off.
    discountBps: integer().notNull(),
    appliesToAll: boolean().notNull().default(false),
    startsAt: timestamp({ withTimezone: true }).notNull(),
    endsAt: timestamp({ withTimezone: true }).notNull(),
    status: promotionStatusEnum().notNull().default('active'),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check('promotions_discount_range', sql`${t.discountBps} between 100 and 9000`),
    check('promotions_dates', sql`${t.endsAt} > ${t.startsAt}`),
    index('promotions_vendor_idx').on(t.vendorId, t.status, t.endsAt),
  ],
).enableRLS();

export const promotionProducts = pgTable(
  'promotion_products',
  {
    promotionId: uuid()
      .notNull()
      .references(() => promotions.id, { onDelete: 'cascade' }),
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.promotionId, t.productId] }),
    index('promotion_products_product_idx').on(t.productId),
  ],
).enableRLS();

/** Product page views per UTC day, for vendor product stats. */
export const productViews = pgTable(
  'product_views',
  {
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    day: date({ mode: 'string' }).notNull(),
    views: bigint({ mode: 'number' }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.productId, t.day] })],
).enableRLS();
