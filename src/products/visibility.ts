import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  products,
  userSuspensions,
  vendors,
} from '../database/schema/index.js';

/**
 * The one rule for what customers can see, used by lists, product pages,
 * category counts and carts: an active, unmoderated, undeleted product of an
 * approved vendor whose account is not suspended.
 */
export const publiclyVisible = () =>
  and(
    eq(products.status, 'active'),
    eq(products.moderationStatus, 'visible'),
    isNull(products.deletedAt),
    sql`exists (select 1 from ${vendors} where ${vendors.userId} = ${products.vendorId} and ${vendors.status} = 'approved')`,
    sql`not exists (select 1 from ${userSuspensions} where ${userSuspensions.userId} = ${products.vendorId})`,
  );
