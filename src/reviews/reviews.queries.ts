import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Executor } from '../database/database.js';
import { productReviews } from '../database/schema/index.js';

export interface RatingSummary {
  average: number | null;
  count: number;
  distribution: Record<'1' | '2' | '3' | '4' | '5', number>;
}

const empty = (): RatingSummary => ({
  average: null,
  count: 0,
  distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
});

/** Visible reviews per product: average, count and stars. */
export async function ratingsFor(db: Executor, productIds: string[]): Promise<Map<string, RatingSummary>> {
  const map = new Map<string, RatingSummary>();
  if (productIds.length === 0) return map;
  const rows = await db
    .select({
      productId: productReviews.productId,
      rating: productReviews.rating,
      n: sql<number>`count(*)::int`,
    })
    .from(productReviews)
    .where(and(inArray(productReviews.productId, productIds), eq(productReviews.status, 'visible')))
    .groupBy(productReviews.productId, productReviews.rating);
  for (const r of rows) {
    const s = map.get(r.productId) ?? empty();
    s.distribution[String(r.rating) as '1'] = r.n;
    s.count += r.n;
    map.set(r.productId, s);
  }
  for (const s of map.values()) {
    const total = Object.entries(s.distribution).reduce((sum, [star, n]) => sum + Number(star) * n, 0);
    s.average = s.count === 0 ? null : Math.round((total / s.count) * 10) / 10;
  }
  return map;
}

export const ratingOf = async (db: Executor, productId: string): Promise<RatingSummary> =>
  (await ratingsFor(db, [productId])).get(productId) ?? empty();

/** "Grace Ajayi" → "Grace A." */
export const shortName = (name: string): string => {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts.at(-1)![0].toUpperCase()}.` : parts[0] || 'Customer';
};
