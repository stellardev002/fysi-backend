import { sql } from 'drizzle-orm';
import { products, promotionProducts, promotions } from '../database/schema/index.js';
import { percentOf } from './pricing.js';

/** Promotions of the product's vendor running now that cover this product. */
const running = sql`${promotions.vendorId} = ${products.vendorId}
  and ${promotions.status} = 'active'
  and ${promotions.startsAt} <= now() and ${promotions.endsAt} > now()
  and (${promotions.appliesToAll} or exists (
    select 1 from ${promotionProducts}
    where ${promotionProducts.promotionId} = ${promotions.id}
      and ${promotionProducts.productId} = ${products.id}))`;

/**
 * Columns to add to a product select: the biggest running discount (they
 * never stack) and the promotion it comes from.
 */
export const PROMO = {
  discountBps: sql<number>`coalesce((select max(${promotions.discountBps}) from ${promotions} where ${running}), 0)`.mapWith(Number),
  promotionId: sql<string | null>`(select ${promotions.id} from ${promotions} where ${running} order by ${promotions.discountBps} desc, ${promotions.id} limit 1)`,
};

/** Sale price in cents, rounded so the customer never pays more than the advertised percentage. */
export const salePrice = (priceCents: number, discountBps: number | null | undefined): number =>
  discountBps ? Math.max(1, priceCents - percentOf(priceCents, discountBps)) : priceCents;
