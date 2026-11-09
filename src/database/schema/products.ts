import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  customType,
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
import { categories } from './categories.js';
import { users } from './users.js';
import { vendors } from './vendors.js';

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

/** Vendor-controlled visibility (PRD V7: hide). */
export const productStatusEnum = pgEnum('product_status', ['active', 'hidden']);
export type ProductStatus = (typeof productStatusEnum.enumValues)[number];

/** Admin moderation (PRD A5). `hidden` can be lifted; `removed` is final. */
export const moderationStatusEnum = pgEnum('moderation_status', [
  'visible',
  'hidden',
  'removed',
]);
export type ModerationStatus = (typeof moderationStatusEnum.enumValues)[number];

export const products = pgTable(
  'products',
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => v7()),
    vendorId: uuid()
      .notNull()
      .references(() => vendors.userId, { onDelete: 'restrict' }),
    categoryId: uuid()
      .notNull()
      .references(() => categories.id, { onDelete: 'restrict' }),
    title: text().notNull(),
    slug: text().notNull().unique(),
    description: text().notNull(),
    // Price in US cents ($12.50 = 1250); settles 1:1 in USDC. Integers only.
    priceCents: bigint({ mode: 'number' }).notNull(),
    stock: integer().notNull(),
    // Subset of the vendor's verified certifications.
    certifications: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: productStatusEnum().notNull().default('active'),
    moderationStatus: moderationStatusEnum().notNull().default('visible'),
    moderationReason: text(),
    moderatedBy: uuid(),
    moderatedAt: timestamp({ withTimezone: true }),
    // Vendor deletion is soft: orders (phase 2) keep pointing at the product.
    deletedAt: timestamp({ withTimezone: true }),
    search: tsvector().generatedAlwaysAs(
      sql`setweight(to_tsvector('english', coalesce("title", '')), 'A') || setweight(to_tsvector('english', coalesce("description", '')), 'B')`,
    ),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check('products_price_positive', sql`${t.priceCents} > 0`),
    check('products_stock_non_negative', sql`${t.stock} >= 0`),
    index('products_vendor_idx').on(t.vendorId, t.createdAt.desc()),
    index('products_category_idx').on(t.categoryId, t.createdAt.desc()),
    index('products_price_idx').on(t.priceCents),
    index('products_search_idx').using('gin', t.search),
  ],
).enableRLS();

export const productImages = pgTable(
  'product_images',
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => v7()),
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    storageKey: text().notNull(),
    position: integer().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('product_images_product_idx').on(t.productId, t.position)],
).enableRLS();

// A signed-in customer's cart (PRD C4). Guests keep theirs in the browser and merge at sign-up.
export const cartItems = pgTable(
  'cart_items',
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    quantity: integer().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.productId] }),
    check('cart_items_quantity_range', sql`${t.quantity} between 1 and 99`),
  ],
).enableRLS();
