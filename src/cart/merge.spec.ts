import { describe, expect, it } from 'vitest';
import { planMerge } from './merge.js';

const stock = new Map([
  ['a', 10],
  ['b', 3],
  ['c', 0],
]);

describe('planMerge', () => {
  it('adds guest items and keeps the larger quantity for shared ones', () => {
    const plan = planMerge(
      [{ productId: 'a', quantity: 4 }],
      [
        { productId: 'a', quantity: 2 },
        { productId: 'b', quantity: 1 },
      ],
      stock,
      99,
    );
    expect(plan.set).toEqual([{ productId: 'b', quantity: 1 }]);
    expect(plan.skipped).toEqual([]);
  });

  it('is idempotent: merging the same guest cart twice changes nothing the second time', () => {
    const guest = [{ productId: 'a', quantity: 6 }];
    const first = planMerge([], guest, stock, 99);
    expect(first.set).toEqual([{ productId: 'a', quantity: 6 }]);
    expect(planMerge(first.set, guest, stock, 99).set).toEqual([]);
  });

  it('caps at stock and the per-line maximum, and dedupes guest lines', () => {
    const plan = planMerge(
      [],
      [
        { productId: 'b', quantity: 2 },
        { productId: 'b', quantity: 9 },
        { productId: 'a', quantity: 50 },
      ],
      stock,
      5,
    );
    expect(plan.set).toEqual([
      { productId: 'b', quantity: 3 },
      { productId: 'a', quantity: 5 },
    ]);
  });

  it('reports products that are gone or sold out', () => {
    const plan = planMerge(
      [],
      [
        { productId: 'c', quantity: 1 },
        { productId: 'zzz', quantity: 1 },
      ],
      stock,
      99,
    );
    expect(plan.set).toEqual([]);
    expect(plan.skipped).toEqual([
      { productId: 'c', reason: 'out_of_stock' },
      { productId: 'zzz', reason: 'unavailable' },
    ]);
  });
});
