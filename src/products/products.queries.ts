import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  max,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { Executor, Tx } from '../database/database.js';
import {
  categories,
  type ModerationStatus,
  productImages,
  products,
  type ProductStatus,
  vendors,
} from '../database/schema/index.js';
import { PROMO } from './promotion-price.js';
import { publiclyVisible } from './visibility.js';

export type ProductRow = typeof products.$inferSelect;
export type ProductImageRow = typeof productImages.$inferSelect;

/** Every column except the generated search vector. */
const PRODUCT = {
  id: products.id,
  vendorId: products.vendorId,
  categoryId: products.categoryId,
  title: products.title,
  slug: products.slug,
  description: products.description,
  priceCents: products.priceCents,
  stock: products.stock,
  certifications: products.certifications,
  status: products.status,
  moderationStatus: products.moderationStatus,
  moderationReason: products.moderationReason,
  moderatedBy: products.moderatedBy,
  moderatedAt: products.moderatedAt,
  deletedAt: products.deletedAt,
  createdAt: products.createdAt,
  updatedAt: products.updatedAt,
};
export type Product = Omit<ProductRow, 'search'>;

const CATEGORY = {
  categoryName: categories.name,
  categorySlug: categories.slug,
};

const VENDOR = {
  vendorSlug: vendors.slug,
  vendorName: vendors.businessName,
  vendorLogoKey: vendors.logoKey,
  vendorCity: vendors.city,
  vendorState: vendors.state,
  vendorCertifications: vendors.verifiedCertifications,
};

const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');

/* ---------------- vendor ---------------- */

export const insertProduct = async (
  tx: Tx,
  values: typeof products.$inferInsert,
): Promise<Product> =>
  (await tx.insert(products).values(values).returning(PRODUCT))[0];

/** The vendor's own product, unless deleted. */
export const lockOwnedProduct = async (
  tx: Tx,
  vendorId: string,
  id: string,
): Promise<Product | undefined> =>
  (
    await tx
      .select(PRODUCT)
      .from(products)
      .where(
        and(
          eq(products.id, id),
          eq(products.vendorId, vendorId),
          isNull(products.deletedAt),
        ),
      )
      .for('update')
  )[0];

export const findOwnedProduct = async (
  db: Executor,
  vendorId: string,
  id: string,
) =>
  (
    await db
      .select({ ...PRODUCT, ...CATEGORY })
      .from(products)
      .innerJoin(categories, eq(categories.id, products.categoryId))
      .where(
        and(
          eq(products.id, id),
          eq(products.vendorId, vendorId),
          isNull(products.deletedAt),
        ),
      )
      .limit(1)
  )[0];

export const updateProduct = async (
  tx: Tx,
  id: string,
  values: Partial<
    Omit<typeof products.$inferInsert, 'id' | 'vendorId' | 'search'>
  >,
): Promise<Product> =>
  (
    await tx
      .update(products)
      .set(values)
      .where(eq(products.id, id))
      .returning(PRODUCT)
  )[0];

export const listVendorProducts = async (
  db: Executor,
  vendorId: string,
  filter: { status?: ProductStatus; q?: string },
  page: { limit: number; offset: number },
) => {
  const where = and(
    eq(products.vendorId, vendorId),
    isNull(products.deletedAt),
    filter.status ? eq(products.status, filter.status) : undefined,
    filter.q?.trim()
      ? sql`${products.title} ilike ${`%${escapeLike(filter.q.trim())}%`}`
      : undefined,
  );
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({ ...PRODUCT, ...CATEGORY })
      .from(products)
      .innerJoin(categories, eq(categories.id, products.categoryId))
      .where(where)
      .orderBy(desc(products.createdAt), desc(products.id))
      .limit(page.limit)
      .offset(page.offset),
    db.select({ total: count() }).from(products).where(where),
  ]);
  return { rows, total };
};

/* ---------------- images ---------------- */

/** Images per product, in display order. */
export const imagesFor = async (
  db: Executor,
  productIds: string[],
): Promise<Map<string, ProductImageRow[]>> => {
  const map = new Map<string, ProductImageRow[]>();
  if (productIds.length === 0) return map;
  const rows = await db
    .select()
    .from(productImages)
    .where(inArray(productImages.productId, productIds))
    .orderBy(asc(productImages.position), asc(productImages.createdAt));
  for (const r of rows) {
    const list = map.get(r.productId) ?? [];
    list.push(r);
    map.set(r.productId, list);
  }
  return map;
};

export const imageStats = async (tx: Tx, productId: string) =>
  (
    await tx
      .select({ n: count(), last: max(productImages.position) })
      .from(productImages)
      .where(eq(productImages.productId, productId))
  )[0];

export const insertImage = (
  tx: Tx,
  values: typeof productImages.$inferInsert,
) => tx.insert(productImages).values(values);

export const deleteImage = async (tx: Tx, productId: string, id: string) =>
  (
    await tx
      .delete(productImages)
      .where(
        and(eq(productImages.productId, productId), eq(productImages.id, id)),
      )
      .returning()
  )[0];

export const setImagePosition = (
  tx: Tx,
  productId: string,
  id: string,
  position: number,
) =>
  tx
    .update(productImages)
    .set({ position })
    .where(
      and(eq(productImages.productId, productId), eq(productImages.id, id)),
    );

/* ---------------- public catalogue ---------------- */

export type CatalogueSort = 'relevance' | 'newest' | 'price_asc' | 'price_desc';

export interface CatalogueFilter {
  q?: string;
  category?: string;
  vendor?: string;
  minPriceCents?: number;
  maxPriceCents?: number;
  certified?: boolean;
  inStock?: boolean;
  sort?: CatalogueSort;
}

/**
 * Full-text search over title (weighted) and description, plus a title
 * substring match so partial words still find something ("bamb" → bamboo).
 */
const searchCondition = (q: string): SQL =>
  sql`(${products.search} @@ websearch_to_tsquery('english', ${q}) or ${products.title} ilike ${`%${escapeLike(q)}%`})`;

export const listPublic = async (
  db: Executor,
  f: CatalogueFilter,
  page: { limit: number; offset: number },
) => {
  const q = f.q?.trim() || undefined;
  const where = and(
    publiclyVisible(),
    q ? searchCondition(q) : undefined,
    f.category ? eq(categories.slug, f.category) : undefined,
    f.vendor ? eq(vendors.slug, f.vendor) : undefined,
    f.minPriceCents !== undefined
      ? gte(products.priceCents, f.minPriceCents)
      : undefined,
    f.maxPriceCents !== undefined
      ? lte(products.priceCents, f.maxPriceCents)
      : undefined,
    f.certified === undefined
      ? undefined
      : f.certified
        ? sql`cardinality(${products.certifications}) > 0`
        : sql`cardinality(${products.certifications}) = 0`,
    f.inStock ? sql`${products.stock} > 0` : undefined,
  );
  const sort = f.sort ?? (q ? 'relevance' : 'newest');
  const order: SQL[] =
    sort === 'price_asc'
      ? [asc(products.priceCents)]
      : sort === 'price_desc'
        ? [desc(products.priceCents)]
        : sort === 'relevance' && q
          ? [
              sql`ts_rank(${products.search}, websearch_to_tsquery('english', ${q})) desc`,
            ]
          : [];
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({ ...PRODUCT, ...CATEGORY, ...VENDOR, ...PROMO })
      .from(products)
      .innerJoin(categories, eq(categories.id, products.categoryId))
      .innerJoin(vendors, eq(vendors.userId, products.vendorId))
      .where(where)
      .orderBy(...order, desc(products.createdAt), desc(products.id))
      .limit(page.limit)
      .offset(page.offset),
    db
      .select({ total: count() })
      .from(products)
      .innerJoin(categories, eq(categories.id, products.categoryId))
      .innerJoin(vendors, eq(vendors.userId, products.vendorId))
      .where(where),
  ]);
  return { rows, total };
};

export const findPublicBySlug = async (db: Executor, slug: string) =>
  (
    await db
      .select({ ...PRODUCT, ...CATEGORY, ...VENDOR, ...PROMO })
      .from(products)
      .innerJoin(categories, eq(categories.id, products.categoryId))
      .innerJoin(vendors, eq(vendors.userId, products.vendorId))
      .where(and(eq(products.slug, slug), publiclyVisible()))
      .limit(1)
  )[0];

/** For carts: the products among `ids` that customers can buy right now. */
export const findPublicByIds = async (db: Executor, ids: string[]) =>
  ids.length === 0
    ? []
    : db
        .select({ ...PRODUCT, ...CATEGORY, ...VENDOR, ...PROMO })
        .from(products)
        .innerJoin(categories, eq(categories.id, products.categoryId))
        .innerJoin(vendors, eq(vendors.userId, products.vendorId))
        .where(and(inArray(products.id, ids), publiclyVisible()));

/* ---------------- admin ---------------- */

export const listAdmin = async (
  db: Executor,
  f: {
    q?: string;
    vendorId?: string;
    moderationStatus?: ModerationStatus;
    includeDeleted?: boolean;
    productId?: string;
  },
  page: { limit: number; offset: number },
) => {
  const where = and(
    f.productId ? eq(products.id, f.productId) : undefined,
    f.includeDeleted ? undefined : isNull(products.deletedAt),
    f.vendorId ? eq(products.vendorId, f.vendorId) : undefined,
    f.moderationStatus
      ? eq(products.moderationStatus, f.moderationStatus)
      : undefined,
    f.q?.trim()
      ? sql`(${products.title} ilike ${`%${escapeLike(f.q.trim())}%`} or ${vendors.businessName} ilike ${`%${escapeLike(f.q.trim())}%`})`
      : undefined,
  );
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        ...PRODUCT,
        ...CATEGORY,
        ...VENDOR,
        vendorStatus: vendors.status,
        isPublic: sql<boolean>`${publiclyVisible()}`,
      })
      .from(products)
      .innerJoin(categories, eq(categories.id, products.categoryId))
      .innerJoin(vendors, eq(vendors.userId, products.vendorId))
      .where(where)
      .orderBy(desc(products.createdAt), desc(products.id))
      .limit(page.limit)
      .offset(page.offset),
    db
      .select({ total: count() })
      .from(products)
      .innerJoin(vendors, eq(vendors.userId, products.vendorId))
      .where(where),
  ]);
  return { rows, total };
};

export const lockProduct = async (
  tx: Tx,
  id: string,
): Promise<Product | undefined> =>
  (await tx.select(PRODUCT).from(products).where(eq(products.id, id)).for('update'))[0];

/** Whether customers can see the product right now. */
export const isPublic = async (db: Executor, id: string) =>
  (
    await db
      .select({ one: sql<number>`1` })
      .from(products)
      .where(and(eq(products.id, id), publiclyVisible()))
      .limit(1)
  ).length > 0;
