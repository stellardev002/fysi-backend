import { describe, expect, it } from 'vitest';
import {
  centsToStroops,
  formatCents,
  percentOf,
  stroopsToCents,
} from './pricing.js';

describe('pricing', () => {
  it('formats cents as dollars', () => {
    expect(formatCents(1250)).toBe('12.50');
    expect(formatCents(5)).toBe('0.05');
    expect(formatCents(100_000_00)).toBe('100000.00');
    expect(formatCents(-199)).toBe('-1.99');
  });

  it('converts between cents and USDC stroops exactly', () => {
    expect(centsToStroops(1250)).toBe(125_000_000n);
    expect(stroopsToCents(125_000_000n)).toEqual({ cents: 1250, remainder: 0n });
    expect(stroopsToCents(125_000_001n)).toEqual({ cents: 1250, remainder: 1n });
  });

  it('takes a percentage in basis points, rounding half up', () => {
    expect(percentOf(10_000, 500)).toBe(500); // 5% of $100
    expect(percentOf(1250, 500)).toBe(63); // 62.5 → 63
    expect(percentOf(1249, 500)).toBe(62); // 62.45 → 62
    expect(percentOf(1250, 0)).toBe(0);
  });
});
