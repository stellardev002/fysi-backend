import { and, asc, count, eq, isNull } from 'drizzle-orm';
import type { Executor, Tx } from '../database/database.js';
import { categories, products } from '../database/schema/index.js';
import { publiclyVisible } from '../products/visibility.js';

export type CategoryRow = typeof categories.$inferSelect;

const ORDER = [asc(categories.sortOrder), asc(categories.name)];

/** Active categories with how many products customers can see in each, for filter chips. */
export const listActiveCategories = (db: Executor) =>
  db
    .select({
      id: categories.id,
      name: categories.name,
      slug: categories.slug,
      productCount: count(products.id),
    })
    .from(categories)
    .leftJoin(
      products,
      and(eq(products.categoryId, categories.id), publiclyVisible()),
    )
    .where(eq(categories.isActive, true))
    .groupBy(categories.id)
    .orderBy(...ORDER);

export const listAllCategories = (db: Executor) =>
  db
    .select({
      id: categories.id,
      name: categories.name,
      slug: categories.slug,
      isActive: categories.isActive,
      sortOrder: categories.sortOrder,
      productCount: count(products.id),
    })
    .from(categories)
    .leftJoin(
      products,
      and(eq(products.categoryId, categories.id), isNull(products.deletedAt)),
    )
    .groupBy(categories.id)
    .orderBy(...ORDER);

export const findCategory = async (db: Executor, id: string) =>
  (await db.select().from(categories).where(eq(categories.id, id)).limit(1))[0];

export const insertCategory = async (
  tx: Tx,
  values: typeof categories.$inferInsert,
): Promise<CategoryRow> =>
  (await tx.insert(categories).values(values).returning())[0];

export const updateCategory = async (
  tx: Tx,
  id: string,
  values: Partial<Pick<CategoryRow, 'name' | 'isActive' | 'sortOrder'>>,
): Promise<CategoryRow | undefined> =>
  (
    await tx
      .update(categories)
      .set(values)
      .where(eq(categories.id, id))
      .returning()
  )[0];
