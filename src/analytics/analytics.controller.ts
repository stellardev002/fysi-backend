import {
  applyDecorators,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Query,
  type StreamableFile,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser } from '../auth/decorators.js';
import { Roles } from '../authorization/roles.decorator.js';
import { ApiErrors, ApiRoute } from '../common/api-docs.js';
import { AnalyticsQueryDto, DateRangeQueryDto } from '../common/date-range.js';
import type { Page } from '../common/pagination.js';
import { roleEnum, type Role, STAFF_ROLES } from '../database/schema/index.js';
import { VendorOrdersQueryDto } from '../orders/dto/orders.dto.js';
import { RateLimit } from '../rate-limit/rate-limit.decorator.js';
import { AnalyticsService } from './analytics.service.js';
import {
  AdminAnalyticsDto,
  ProductStatsDetailDto,
  ProductStatsDto,
  ProductStatsQueryDto,
  StatementDto,
  StatementQueryDto,
  VendorAnalyticsDto,
  VendorDashboardDto,
} from './dto/analytics.dto.js';
import { ExportsService } from './exports.service.js';

/** A CSV download: no JSON envelope. */
const ApiCsv = (summary: string, path: string, description: string) =>
  applyDecorators(
    RateLimit({ capacity: 10, refillPerSec: 1 / 6 }),
    ApiOperation({
      summary,
      description: `${description}\n\nUTF-8 CSV with a header row (opens in Excel and Google Sheets), at most 50,000 rows. Amounts are US dollars. Cells that look like formulas are prefixed with \`'\`.`,
    }),
    ApiProduces('text/csv'),
    ApiOkResponse({ description: 'The CSV file (`Content-Disposition: attachment`).', schema: { type: 'string', format: 'binary' } }),
    ApiErrors(path, HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN, HttpStatus.TOO_MANY_REQUESTS),
  );

const VENDOR_ERRORS = [HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN];

class ExportOrdersQueryDto extends VendorOrdersQueryDto {}

@ApiTags('Vendor Dashboard')
@ApiBearerAuth()
@Roles('vendor')
@Controller('vendor')
export class VendorAnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly exports: ExportsService,
  ) {}

  @ApiRoute({
    summary: 'Dashboard',
    path: '/api/v1/vendor/dashboard',
    description: 'What needs doing now (orders to ship, problems, low stock), pending payout, last 30 days and rating.',
    message: 'Dashboard retrieved',
    model: VendorDashboardDto,
    example: {
      orders: { toShip: 3, inTransit: 5, problems: 0, awaitingConfirmation: 2 },
      products: { active: 24, hidden: 2, outOfStock: 1, lowStock: 3 },
      pendingPayout: { cents: 18750, usd: '187.50' },
      last30DaysSales: { cents: 64200, usd: '642.00' },
      last30DaysOrders: 14,
      rating: { average: 4.6, count: 23 },
      runningPromotions: 1,
      unreadNotifications: 4,
    },
    errors: VENDOR_ERRORS,
  })
  @Get('dashboard')
  dashboard(@CurrentUser() user: AuthUser): Promise<VendorDashboardDto> {
    return this.analytics.vendorDashboard(user.id);
  }

  @ApiRoute({
    summary: 'Sales analytics',
    path: '/api/v1/vendor/analytics',
    description:
      'Sales, net (after commission), orders, units, average order, product views and conversion over a range (default: the last 30 days), each compared with the period before; a series by day, week or month; top products. Cancelled and refunded orders are left out of sales and shown as `refunds`.',
    message: 'Analytics retrieved',
    model: VendorAnalyticsDto,
    errors: [HttpStatus.BAD_REQUEST, ...VENDOR_ERRORS],
  })
  @Get('analytics')
  analyticsFor(@CurrentUser() user: AuthUser, @Query() q: AnalyticsQueryDto): Promise<VendorAnalyticsDto> {
    return this.analytics.vendorAnalytics(user.id, q);
  }

  @ApiRoute({
    summary: 'Product stats',
    path: '/api/v1/vendor/product-stats',
    description: 'Per product over the range: views, orders, units, sales, conversion, wishlist saves and rating. Sort by sales, units, views or title.',
    message: 'Product stats retrieved',
    model: ProductStatsDto,
    paginated: true,
    errors: [HttpStatus.BAD_REQUEST, ...VENDOR_ERRORS],
  })
  @Get('product-stats')
  productStats(@CurrentUser() user: AuthUser, @Query() q: ProductStatsQueryDto): Promise<Page<ProductStatsDto>> {
    return this.analytics.productStats(user.id, q);
  }

  @ApiRoute({
    summary: 'Stats of one product',
    path: '/api/v1/vendor/product-stats/{productId}',
    description: 'The same numbers plus a sales series and views per day.',
    message: 'Product stats retrieved',
    model: ProductStatsDetailDto,
    errors: [HttpStatus.BAD_REQUEST, ...VENDOR_ERRORS, { status: HttpStatus.NOT_FOUND, message: 'Product not found' }],
  })
  @Get('product-stats/:productId')
  productStatsDetail(
    @CurrentUser() user: AuthUser,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Query() q: AnalyticsQueryDto,
  ): Promise<ProductStatsDetailDto> {
    return this.analytics.productStatsDetail(user.id, productId, q);
  }

  @ApiRoute({
    summary: 'Account statement',
    path: '/api/v1/vendor/statements',
    description: `Earnings and withdrawals over a range (default: the last 30 days, at most a year), oldest first with a running balance.

- \`sale\`: what the customer paid for your items, on the day it was paid.
- \`commission\`: the Fysi commission on that sale.
- \`refund\`: a sale cancelled and refunded (the commission is returned with it).
- \`withdrawal\`: USDC sent from your wallet to your own address.

Balance = earnings minus withdrawals. A sale's \`status\` shows whether its payout is still in escrow (\`held\`) or paid out. CSV: \`GET /vendor/statements/export.csv\`.`,
    message: 'Statement retrieved',
    model: StatementDto,
    errors: [HttpStatus.BAD_REQUEST, ...VENDOR_ERRORS],
  })
  @Get('statements')
  statement(@CurrentUser() user: AuthUser, @Query() q: StatementQueryDto): Promise<StatementDto> {
    return this.analytics.statement(user.id, q);
  }

  @ApiCsv('Account statement (CSV)', '/api/v1/vendor/statements/export.csv', 'The statement for the range, with opening and closing balance rows.')
  @Get('statements/export.csv')
  statementCsv(@CurrentUser() user: AuthUser, @Query() q: StatementQueryDto): Promise<StreamableFile> {
    return this.exports.vendorStatement(user.id, q);
  }

  @ApiCsv('My orders (CSV)', '/api/v1/vendor/exports/orders.csv', 'Paid orders with items, payout breakdown and shipping. Takes the same filters as `GET /vendor/orders`.')
  @Get('exports/orders.csv')
  ordersCsv(@CurrentUser() user: AuthUser, @Query() q: ExportOrdersQueryDto): Promise<StreamableFile> {
    return this.exports.vendorOrders(user.id, q);
  }

  @ApiCsv('My products with stats (CSV)', '/api/v1/vendor/exports/products.csv', 'Every product with price, stock and the stats for the range (default: the last 30 days).')
  @Get('exports/products.csv')
  productsCsv(@CurrentUser() user: AuthUser, @Query() q: DateRangeQueryDto): Promise<StreamableFile> {
    return this.exports.vendorProducts(user.id, q);
  }
}

class UsersExportQueryDto extends DateRangeQueryDto {
  @ApiPropertyOptional({ enum: roleEnum.enumValues })
  @IsOptional()
  @IsIn(roleEnum.enumValues)
  role?: Role;
}

const RANGE_NOTE = '`from`/`to` filter by creation date; without them, everything.';

@ApiTags('Admin Analytics & Exports')
@ApiBearerAuth()
@Roles(...STAFF_ROLES)
@Controller('admin')
export class AdminAnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly exports: ExportsService,
  ) {}

  @ApiRoute({
    summary: 'Marketplace analytics',
    path: '/api/v1/admin/analytics',
    description:
      'GMV, commission, orders, average order, sign-ups, buyers and repeat-buyer rate over a range (default: the last 30 days), each compared with the period before; a series; top vendors, products and categories; vendor orders by status. `GET /admin/dashboard` keeps the work queues.',
    message: 'Analytics retrieved',
    model: AdminAnalyticsDto,
    errors: [HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN],
  })
  @Get('analytics')
  analyticsFor(@Query() q: AnalyticsQueryDto): Promise<AdminAnalyticsDto> {
    return this.analytics.adminAnalytics(q);
  }

  @ApiCsv('Users (CSV)', '/api/v1/admin/exports/users.csv', `Accounts, optionally one \`role\`. ${RANGE_NOTE}`)
  @Get('exports/users.csv')
  usersCsv(@Query() q: UsersExportQueryDto): Promise<StreamableFile> {
    return this.exports.users(q.role, q);
  }

  @ApiCsv('Customers (CSV)', '/api/v1/admin/exports/customers.csv', RANGE_NOTE)
  @Get('exports/customers.csv')
  customersCsv(@Query() q: DateRangeQueryDto): Promise<StreamableFile> {
    return this.exports.users('customer', q);
  }

  @ApiCsv('Vendors (CSV)', '/api/v1/admin/exports/vendors.csv', `Businesses with verification status. ${RANGE_NOTE}`)
  @Get('exports/vendors.csv')
  vendorsCsv(@Query() q: DateRangeQueryDto): Promise<StreamableFile> {
    return this.exports.vendors(q);
  }

  @ApiCsv('Orders (CSV)', '/api/v1/admin/exports/orders.csv', `One row per vendor order, with escrow state. ${RANGE_NOTE}`)
  @Get('exports/orders.csv')
  ordersCsv(@Query() q: DateRangeQueryDto): Promise<StreamableFile> {
    return this.exports.orders(q);
  }

  @ApiCsv('Payments (CSV)', '/api/v1/admin/exports/payments.csv', `Every payment the watcher saw, with transaction hashes. ${RANGE_NOTE}`)
  @Get('exports/payments.csv')
  paymentsCsv(@Query() q: DateRangeQueryDto): Promise<StreamableFile> {
    return this.exports.payments(q);
  }

  @ApiCsv('Products (CSV)', '/api/v1/admin/exports/products.csv', `Including hidden, removed and deleted products. ${RANGE_NOTE}`)
  @Get('exports/products.csv')
  productsCsv(@Query() q: DateRangeQueryDto): Promise<StreamableFile> {
    return this.exports.products(q);
  }

  @ApiCsv('Newsletter subscribers (CSV)', '/api/v1/admin/exports/newsletter.csv', '`from`/`to` filter by subscription date.')
  @Get('exports/newsletter.csv')
  newsletterCsv(@Query() q: DateRangeQueryDto): Promise<StreamableFile> {
    return this.exports.newsletter(q);
  }

  @ApiCsv('Help tickets (CSV)', '/api/v1/admin/exports/tickets.csv', RANGE_NOTE)
  @Get('exports/tickets.csv')
  ticketsCsv(@Query() q: DateRangeQueryDto): Promise<StreamableFile> {
    return this.exports.tickets(q);
  }
}
