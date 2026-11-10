import { describe, expect, it } from 'vitest';
import { csvCell, toCsv } from './csv.js';
import { change, previousRange, rangeOf } from './date-range.js';

describe('csv', () => {
  it('quotes separators and neutralises formulas', () => {
    expect(csvCell('Tote, organic')).toBe('"Tote, organic"');
    expect(csvCell('She said "hi"')).toBe('"She said ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell(-12.5)).toBe('-12.5');
    expect(csvCell(null)).toBe('');
    expect(csvCell(new Date('2026-11-10T00:00:00Z'))).toBe('2026-11-10T00:00:00.000Z');
  });

  it('starts with a BOM and ends rows with CRLF', () => {
    expect(toCsv(['a', 'b'], [[1, 'x']])).toBe('﻿a,b\r\n1,x\r\n');
  });
});

describe('date range', () => {
  it('is inclusive of both days and compares with the period before', () => {
    const r = rangeOf({ from: '2026-10-01', to: '2026-10-31' });
    expect(r.days).toBe(31);
    expect(r.to.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(previousRange(r).from.toISOString()).toBe('2026-08-31T00:00:00.000Z');
    expect(() => rangeOf({ from: '2026-11-02', to: '2026-11-01' })).toThrow();
    expect(() => rangeOf({ from: '2024-01-01', to: '2026-01-01' })).toThrow(/at most/);
  });

  it('reports change in percent, or null against zero', () => {
    expect(change(150, 100)).toBe(50);
    expect(change(1, 3)).toBe(-66.7);
    expect(change(5, 0)).toBeNull();
  });
});
