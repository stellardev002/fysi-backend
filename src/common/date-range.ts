import { BadRequestException } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { IsCalendarDate } from './calendar-date.js';

const DAY_MS = 86_400_000;

export class DateRangeQueryDto {
  @ApiPropertyOptional({ example: '2026-10-01', description: 'First day (UTC), inclusive.' })
  @IsOptional()
  @IsCalendarDate()
  from?: string;

  @ApiPropertyOptional({ example: '2026-10-31', description: 'Last day (UTC), inclusive.' })
  @IsOptional()
  @IsCalendarDate()
  to?: string;
}

export class AnalyticsQueryDto extends DateRangeQueryDto {
  @ApiPropertyOptional({
    enum: ['day', 'week', 'month'],
    default: 'day',
    description: 'Bucket size of the series.',
  })
  @IsOptional()
  @IsIn(['day', 'week', 'month'])
  period: 'day' | 'week' | 'month' = 'day';
}

export interface Range {
  /** Inclusive start. */
  from: Date;
  /** Exclusive end (the day after `to`). */
  to: Date;
  days: number;
}

/**
 * `from`/`to` as a half-open UTC range. Without `from`, the last
 * `defaultDays` days up to today; at most `maxDays` long.
 */
export function rangeOf(q: DateRangeQueryDto, defaultDays = 30, maxDays = 366): Range {
  const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  const to = q.to ? new Date(`${q.to}T00:00:00Z`) : today;
  const end = new Date(to.getTime() + DAY_MS);
  const from = q.from
    ? new Date(`${q.from}T00:00:00Z`)
    : new Date(end.getTime() - defaultDays * DAY_MS);
  if (from >= end) throw new BadRequestException('from must be on or before to');
  const days = Math.round((end.getTime() - from.getTime()) / DAY_MS);
  if (days > maxDays) throw new BadRequestException(`The range can be at most ${maxDays} days`);
  return { from, to: end, days };
}

/** The range of the same length just before, for "vs previous period". */
export const previousRange = (r: Range): Range => ({
  from: new Date(r.from.getTime() - r.days * DAY_MS),
  to: r.from,
  days: r.days,
});

/** Percent change, one decimal; null when there is nothing to compare with. */
export const change = (now: number, before: number): number | null =>
  before === 0 ? null : Math.round(((now - before) / before) * 1000) / 10;
