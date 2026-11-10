import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { IsCalendarDate } from '../../common/calendar-date.js';
import { AnalyticsQueryDto, DateRangeQueryDto } from '../../common/date-range.js';
import { PaginationQueryDto } from '../../common/pagination.js';
import { PriceDto } from '../../products/dto/products.dto.js';

export class MetricDto {
  @ApiProperty({ example: 1250 }) value: number;
  @ApiProperty({ example: 980, description: 'Same metric over the period of equal length just before.' })
  previous: number;
  @ApiProperty({ example: 27.6, nullable: true, description: 'Percent change; null when previous is 0.' })
  change: number | null;
}

export class MoneyMetricDto {
  @ApiProperty({ type: PriceDto }) value: PriceDto;
  @ApiProperty({ type: PriceDto }) previous: PriceDto;
  @ApiProperty({ example: 12.4, nullable: true }) change: number | null;
}

/* ---------------- vendor ---------------- */

export class VendorDashboardDto {
  @ApiProperty({
    example: { toShip: 3, inTransit: 5, problems: 0, awaitingConfirmation: 2 },
    description: '`toShip`: paid or processing. `inTransit`: shipped. `awaitingConfirmation`: delivered, payout not released.',
  })
  orders: { toShip: number; inTransit: number; problems: number; awaitingConfirmation: number };

  @ApiProperty({
    example: { active: 24, hidden: 2, outOfStock: 1, lowStock: 3 },
    description: '`lowStock`: 1–5 left.',
  })
  products: { active: number; hidden: number; outOfStock: number; lowStock: number };

  @ApiProperty({ type: PriceDto, description: 'Escrow not yet in the wallet.' }) pendingPayout: PriceDto;
  @ApiProperty({ type: PriceDto, description: 'Net sales in the last 30 days.' }) last30DaysSales: PriceDto;
  @ApiProperty({ example: 14 }) last30DaysOrders: number;
  @ApiProperty({ example: { average: 4.6, count: 23 } }) rating: { average: number | null; count: number };
  @ApiProperty({ example: 2, description: 'Promotions running now.' }) runningPromotions: number;
  @ApiProperty({ example: 4, description: 'Unread inbox notifications.' }) unreadNotifications: number;
}

export class SeriesPointDto {
  @ApiProperty({ example: '2026-11-09', description: 'Start of the day, ISO week or month (UTC).' }) period: string;
  @ApiProperty({ example: 3 }) orders: number;
  @ApiProperty({ example: 5 }) units: number;
  @ApiProperty({ type: PriceDto, description: 'Gross sales (what customers paid).' }) sales: PriceDto;
  @ApiProperty({ type: PriceDto, description: 'Sales minus commission.' }) net: PriceDto;
}

export class TopProductDto {
  @ApiProperty({ format: 'uuid' }) productId: string;
  @ApiProperty() title: string;
  @ApiProperty({ example: 12 }) units: number;
  @ApiProperty({ type: PriceDto }) sales: PriceDto;
}

export class VendorAnalyticsDto {
  @ApiProperty({ example: '2026-10-11' }) from: string;
  @ApiProperty({ example: '2026-11-09' }) to: string;
  @ApiProperty({ type: MoneyMetricDto }) sales: MoneyMetricDto;
  @ApiProperty({ type: MoneyMetricDto }) net: MoneyMetricDto;
  @ApiProperty({ type: MetricDto }) orders: MetricDto;
  @ApiProperty({ type: MetricDto }) units: MetricDto;
  @ApiProperty({ type: MoneyMetricDto, description: 'Average order value.' }) averageOrder: MoneyMetricDto;
  @ApiProperty({ type: MetricDto, description: 'Product page views.' }) views: MetricDto;
  @ApiProperty({ example: 2.4, nullable: true, description: 'Orders per 100 product views.' }) conversionRate: number | null;
  @ApiProperty({ type: MoneyMetricDto, description: 'Refunded to customers (cancellations).' }) refunds: MoneyMetricDto;
  @ApiProperty({ type: [SeriesPointDto] }) series: SeriesPointDto[];
  @ApiProperty({ type: [TopProductDto] }) topProducts: TopProductDto[];
}

export class ProductStatsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ example: '2026-10-01', description: 'Default: the last 30 days.' })
  @IsOptional()
  @IsCalendarDate()
  from?: string;

  @ApiPropertyOptional({ example: '2026-10-31' })
  @IsOptional()
  @IsCalendarDate()
  to?: string;

  @ApiPropertyOptional({ enum: ['sales', 'units', 'views', 'title'], default: 'sales' })
  @IsOptional()
  @IsIn(['sales', 'units', 'views', 'title'])
  sort: 'sales' | 'units' | 'views' | 'title' = 'sales';
}

export class ProductStatsDto {
  @ApiProperty({ format: 'uuid' }) productId: string;
  @ApiProperty() title: string;
  @ApiProperty() slug: string;
  @ApiProperty({ type: PriceDto }) price: PriceDto;
  @ApiProperty({ example: 14 }) stock: number;
  @ApiProperty({ example: 'active' }) status: string;
  @ApiProperty({ example: 340 }) views: number;
  @ApiProperty({ example: 9 }) orders: number;
  @ApiProperty({ example: 12 }) units: number;
  @ApiProperty({ type: PriceDto }) sales: PriceDto;
  @ApiProperty({ example: 2.6, nullable: true, description: 'Orders per 100 views.' }) conversionRate: number | null;
  @ApiProperty({ example: 21, description: 'Customers who saved it.' }) wishlisted: number;
  @ApiProperty({ example: { average: 4.6, count: 7 } }) rating: { average: number | null; count: number };
}

export class ProductStatsDetailDto extends ProductStatsDto {
  @ApiProperty({ example: '2026-10-11' }) from: string;
  @ApiProperty({ example: '2026-11-09' }) to: string;
  @ApiProperty({ type: [SeriesPointDto] }) series: SeriesPointDto[];
  @ApiProperty({
    type: 'array',
    example: [{ day: '2026-11-09', views: 14 }],
    description: 'Views per day.',
  })
  viewSeries: { day: string; views: number }[];
}

export const STATEMENT_ENTRY_TYPES = ['sale', 'commission', 'refund', 'withdrawal'] as const;

export class StatementEntryDto {
  @ApiProperty() at: Date;
  @ApiProperty({ enum: STATEMENT_ENTRY_TYPES }) type: (typeof STATEMENT_ENTRY_TYPES)[number];
  @ApiProperty({ example: 'FYK3M9QXWA', description: 'Order number or withdrawal memo.' }) reference: string;
  @ApiProperty({ example: 'Sale: Organic cotton tote bag × 2' }) description: string;
  @ApiProperty({ type: PriceDto, description: 'Positive: earned. Negative: taken off.' }) amount: PriceDto;
  @ApiProperty({ type: PriceDto, description: 'Running balance of earnings after this entry.' }) balance: PriceDto;
  @ApiProperty({ example: 'paid_out', description: 'Escrow state for sales; transfer status for withdrawals.' })
  status: string;
}

export class StatementDto {
  @ApiProperty({ example: '2026-10-01' }) from: string;
  @ApiProperty({ example: '2026-10-31' }) to: string;
  @ApiProperty({ type: PriceDto, description: 'Earnings minus withdrawals before `from`.' }) openingBalance: PriceDto;
  @ApiProperty({ type: PriceDto }) grossSales: PriceDto;
  @ApiProperty({ type: PriceDto }) commission: PriceDto;
  @ApiProperty({ type: PriceDto }) refunds: PriceDto;
  @ApiProperty({ type: PriceDto, description: 'Gross sales minus commission and refunds.' }) netEarnings: PriceDto;
  @ApiProperty({ type: PriceDto }) withdrawals: PriceDto;
  @ApiProperty({ type: PriceDto }) closingBalance: PriceDto;
  @ApiProperty({ type: [StatementEntryDto] }) entries: StatementEntryDto[];
}

export class StatementQueryDto extends DateRangeQueryDto {}

/* ---------------- admin ---------------- */

export class RankedDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'EcoThreads Lagos' }) name: string;
  @ApiProperty({ example: 41 }) orders: number;
  @ApiProperty({ type: PriceDto }) sales: PriceDto;
}

export class AdminSeriesPointDto {
  @ApiProperty({ example: '2026-11-09' }) period: string;
  @ApiProperty() orders: number;
  @ApiProperty({ type: PriceDto, description: 'Gross merchandise value.' }) gmv: PriceDto;
  @ApiProperty({ type: PriceDto, description: 'Fysi commission.' }) commission: PriceDto;
  @ApiProperty() newCustomers: number;
  @ApiProperty() newVendors: number;
}

export class AdminAnalyticsDto {
  @ApiProperty({ example: '2026-10-11' }) from: string;
  @ApiProperty({ example: '2026-11-09' }) to: string;
  @ApiProperty({ type: MoneyMetricDto, description: 'Gross merchandise value of paid orders.' }) gmv: MoneyMetricDto;
  @ApiProperty({ type: MoneyMetricDto, description: 'Commission earned.' }) commission: MoneyMetricDto;
  @ApiProperty({ type: MetricDto }) orders: MetricDto;
  @ApiProperty({ type: MoneyMetricDto }) averageOrder: MoneyMetricDto;
  @ApiProperty({ type: MetricDto }) newCustomers: MetricDto;
  @ApiProperty({ type: MetricDto }) newVendors: MetricDto;
  @ApiProperty({ type: MetricDto, description: 'Distinct customers who paid an order.' }) buyers: MetricDto;
  @ApiProperty({ example: 18.5, nullable: true, description: 'Percent of buyers who had paid before the period.' })
  repeatBuyerRate: number | null;
  @ApiProperty({ type: MoneyMetricDto }) refunds: MoneyMetricDto;
  @ApiProperty({ example: { awaiting_payment: 3, paid: 12, processing: 4, shipped: 9, delivered: 30, cancelled: 2 } })
  vendorOrdersByStatus: Record<string, number>;
  @ApiProperty({ type: [AdminSeriesPointDto] }) series: AdminSeriesPointDto[];
  @ApiProperty({ type: [RankedDto] }) topVendors: RankedDto[];
  @ApiProperty({ type: [RankedDto] }) topProducts: RankedDto[];
  @ApiProperty({ type: [RankedDto] }) topCategories: RankedDto[];
}

export { AnalyticsQueryDto, DateRangeQueryDto };
