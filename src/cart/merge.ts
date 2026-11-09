export interface Line {
  productId: string;
  quantity: number;
}

export interface MergePlan {
  /** Final quantity per product to write. */
  set: Line[];
  skipped: { productId: string; reason: 'unavailable' | 'out_of_stock' }[];
}

/**
 * Merges the browser cart into the account cart at sign-up or login (PRD C4).
 *
 * For a product in both, the larger quantity wins rather than the sum, so a
 * retried or repeated merge never doubles the cart. Quantities are capped by
 * stock and `maxQuantity`; products no longer sold are skipped and reported.
 * Duplicate guest lines for one product count once (largest quantity).
 */
export function planMerge(
  account: Line[],
  guest: Line[],
  stock: Map<string, number>,
  maxQuantity: number,
): MergePlan {
  const current = new Map(account.map((l) => [l.productId, l.quantity]));
  const wanted = new Map<string, number>();
  for (const l of guest)
    wanted.set(l.productId, Math.max(wanted.get(l.productId) ?? 0, l.quantity));

  const set: Line[] = [];
  const skipped: MergePlan['skipped'] = [];
  for (const [productId, quantity] of wanted) {
    const available = stock.get(productId);
    if (available === undefined) {
      skipped.push({ productId, reason: 'unavailable' });
      continue;
    }
    if (available <= 0) {
      skipped.push({ productId, reason: 'out_of_stock' });
      continue;
    }
    const target = Math.min(
      Math.max(current.get(productId) ?? 0, quantity),
      available,
      maxQuantity,
    );
    if (target !== current.get(productId)) set.push({ productId, quantity: target });
  }
  return { set, skipped };
}
