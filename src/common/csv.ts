import { StreamableFile } from '@nestjs/common';

/** Exports stop here; narrow the date range for more. */
export const MAX_EXPORT_ROWS = 50_000;

export type CsvCell = string | number | bigint | boolean | Date | null | undefined;

/**
 * Text that starts like a formula (= + - @, tab, CR) is prefixed with `'`, so
 * a product title or a customer name cannot run as a formula in Excel or
 * Google Sheets (CSV injection). Numbers are left alone.
 */
export function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  let s = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: readonly string[], rows: readonly CsvCell[][]): string {
  const lines = [columns, ...rows].map((r) => r.map(csvCell).join(','));
  // BOM: Excel then reads the file as UTF-8 (₦, é, names with accents).
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** A CSV download, e.g. `fysi-orders-2026-11-10.csv`. */
export function csvFile(
  name: string,
  columns: readonly string[],
  rows: readonly CsvCell[][],
): StreamableFile {
  const day = new Date().toISOString().slice(0, 10);
  return new StreamableFile(Buffer.from(toCsv(columns, rows), 'utf8'), {
    type: 'text/csv; charset=utf-8',
    disposition: `attachment; filename="fysi-${name}-${day}.csv"`,
  });
}

/** Cents as a plain dollar number for spreadsheets: 1250 → 12.50. */
export const usd = (cents: number): string => (cents / 100).toFixed(2);
