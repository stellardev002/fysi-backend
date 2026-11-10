import { Injectable, NotFoundException } from '@nestjs/common';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import {
  change,
  previousRange,
  type Range,
  rangeOf,
} from '../common/date-range.js';
import { type Page, toPage } from '../common/pagination.js';
import { Database } from '../database/database.js';
import {
  productReviews,
  products,
  productViews,
  promotions,
  vendorOrders,
  wishlistItems,
} from '../database/schema/index.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { pendingEscrowCents } from '../payments/payments.queries.js';
import type { PriceDto } from '../products/dto/products.dto.js';
import { ProductsService } from '../products/products.service.js';
import { ratingsFor } from '../reviews/reviews.queries.js';
import {
  ledger,
  people,
  series,
  signupSeries,
  SOLD,
  topCategories,
  topProducts,
  topVendors,
  totals,
  vendorOrdersByStatus,
  views,
} from './analytics.queries.js';
import type {
  AdminAnalyticsDto,
  AnalyticsQueryDto,
  MetricDto,
  MoneyMetricDto,
  ProductStatsDetailDto,
  ProductStatsDto,
  ProductStatsQueryDto,
  StatementDto,
  StatementQueryDto,
  VendorAnalyticsDto,
  VendorDashboardDto,
} from './dto/analytics.dto.js';

const day = (d: Date) => d.toISOString().slice(0, 10);
const lastDay = (r: Range) => day(new Date(r.to.getTime() - 86_400_000));
const per100 = (orders: number, viewCount: number) =>
  viewCount === 0 ? null : Math.round((orders / viewCount) * 1000) / 10;

/** Vendor dashboard, analytics, product stats and statements; admin analytics. */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly database: Database,
    private readonly products: ProductsService,
    private readonly notifications: NotificationsService,
  ) {}

  private price(cents: number): PriceDto {
    return this.products.price(cents);
  }

  private metric(now: number, before: number): MetricDto {
    return { value: now, previous: before, change: change(now, before) };
  }

  private money(now: number, before: number): MoneyMetricDto {
    return { value: this.price(now), previous: this.price(before), change: change(now, before) };
  }

  /* ---------------- vendor ---------------- */

  async vendorDashboard(vendorId: string): Promise<VendorDashboardDto> {
    const db = this.database.db;
    const live = and(eq(products.vendorId, vendorId), isNull(products.deletedAt));
    const [[o], [p], pending, last30, ratings, [promo], unread] = await Promise.all([
      db
        .select({
          toShip: sql<number>`count(*) filter (where ${vendorOrders.status} in ('paid', 'processing') and ${vendorOrders.escrowStatus} = 'held')::int`,
          inTransit: sql<number>`count(*) filter (where ${vendorOrders.status} = 'shipped' and ${vendorOrders.escrowStatus} in ('held', 'disputed'))::int`,
          problems: sql<number>`count(*) filter (where ${vendorOrders.escrowStatus} = 'disputed')::int`,
          awaitingConfirmation: sql<number>`count(*) filter (where ${vendorOrders.status} = 'delivered' and ${vendorOrders.escrowStatus} = 'held')::int`,
        })
        .from(vendorOrders)
        .where(eq(vendorOrders.vendorId, vendorId)),
      db
        .select({
          active: sql<number>`count(*) filter (where ${products.status} = 'active' and ${products.moderationStatus} = 'visible')::int`,
          hidden: sql<number>`count(*) filter (where ${products.status} = 'hidden' or ${products.moderationStatus} <> 'visible')::int`,
          outOfStock: sql<number>`count(*) filter (where ${products.stock} = 0)::int`,
          lowStock: sql<number>`count(*) filter (where ${products.stock} between 1 and 5)::int`,
        })
        .from(products)
        .where(live),
      pendingEscrowCents(db, vendorId),
      totals(db, vendorId, rangeOf({}, 30)),
      db
        .select({
          average: sql<string | null>`round(avg(${productReviews.rating}), 1)`,
          n: sql<number>`count(*)::int`,
        })
        .from(productReviews)
        .where(and(eq(productReviews.vendorId, vendorId), eq(productReviews.status, 'visible'))),
      db
        .select({ n: count() })
        .from(promotions)
        .where(
          and(
            eq(promotions.vendorId, vendorId),
            sql`${promotions.status} = 'active' and ${promotions.startsAt} <= now() and ${promotions.endsAt} > now()`,
          ),
        ),
      this.notifications.unreadCount(vendorId),
    ]);
    return {
      orders: o,
      products: p,
      pendingPayout: this.price(pending),
      last30DaysSales: this.price(last30.sales),
      last30DaysOrders: last30.orders,
      rating: { average: ratings[0].average === null ? null : Number(ratings[0].average), count: ratings[0].n },
      runningPromotions: promo.n,
      unreadNotifications: unread,
    };
  }

  async vendorAnalytics(vendorId: string, q: AnalyticsQueryDto): Promise<VendorAnalyticsDto> {
    const db = this.database.db;
    const r = rangeOf(q);
    const prev = previousRange(r);
    const [now, before, viewsNow, viewsBefore, points, top] = await Promise.all([
      totals(db, vendorId, r),
      totals(db, vendorId, prev),
      views(db, vendorId, r),
      views(db, vendorId, prev),
      series(db, vendorId, r, q.period),
      topProducts(db, vendorId, r),
    ]);
    const aov = (t: { sales: number; orders: number }) => (t.orders ? Math.round(t.sales / t.orders) : 0);
    return {
      from: day(r.from),
      to: lastDay(r),
      sales: this.money(now.sales, before.sales),
      net: this.money(now.net, before.net),
      orders: this.metric(now.orders, before.orders),
      units: this.metric(now.units, before.units),
      averageOrder: this.money(aov(now), aov(before)),
      views: this.metric(viewsNow, viewsBefore),
      conversionRate: per100(now.orders, viewsNow),
      refunds: this.money(now.refunds, before.refunds),
      series: points.map((s) => ({
        period: s.period,
        orders: s.orders,
        units: s.units,
        sales: this.price(s.sales),
        net: this.price(s.net),
      })),
      topProducts: top.map((t) => ({ productId: t.id, title: t.name, units: t.units, sales: this.price(t.sales) })),
    };
  }

  async productStats(vendorId: string, q: ProductStatsQueryDto): Promise<Page<ProductStatsDto>> {
    const { rows, total } = await this.statsRows(vendorId, rangeOf(q), q);
    return toPage(rows, total, q);
  }

  async productStatsDetail(vendorId: string, productId: string, q: AnalyticsQueryDto): Promise<ProductStatsDetailDto> {
    const r = rangeOf(q);
    const { rows } = await this.statsRows(vendorId, r, { limit: 1, offset: 0, sort: 'title' }, productId);
    if (!rows[0]) throw new NotFoundException('Product not found');
    const db = this.database.db;
    const [points, viewRows] = await Promise.all([
      series(db, vendorId, r, q.period, productId),
      db
        .select({ day: productViews.day, views: productViews.views })
        .from(productViews)
        .where(
          and(
            eq(productViews.productId, productId),
            sql`${productViews.day} >= ${day(r.from)} and ${productViews.day} < ${day(r.to)}`,
          ),
        )
        .orderBy(productViews.day),
    ]);
    return {
      ...rows[0],
      from: day(r.from),
      to: lastDay(r),
      series: points.map((s) => ({
        period: s.period,
        orders: s.orders,
        units: s.units,
        sales: this.price(s.sales),
        net: this.price(s.net),
      })),
      viewSeries: viewRows.map((v) => ({ day: v.day, views: Number(v.views) })),
    };
  }

  /** Per-product views, orders, units, sales, wishlist saves and rating over a range. */
  async statsRows(
    vendorId: string,
    r: Range,
    page: { limit: number; offset: number; sort: ProductStatsQueryDto['sort'] },
    productId?: string,
  ): Promise<{ rows: ProductStatsDto[]; total: number }> {
    const db = this.database.db;
    const where = sql`${products.vendorId} = ${vendorId} and ${products.deletedAt} is null ${productId ? sql`and ${products.id} = ${productId}` : sql``}`;
    const order =
      page.sort === 'title'
        ? sql`${products.title} asc`
        : page.sort === 'units'
          ? sql`units desc`
          : page.sort === 'views'
            ? sql`views desc`
            : sql`sales desc`;
    const [result, [{ total }]] = await Promise.all([
      db.execute(sql`
        select ${products.id} as id, ${products.title} as title, ${products.slug} as slug,
          ${products.priceCents} as price, ${products.stock} as stock, ${products.status} as status,
          coalesce(v.views, 0) as views, coalesce(s.orders, 0) as orders, coalesce(s.units, 0) as units,
          coalesce(s.sales, 0) as sales,
          (select count(*) from ${wishlistItems} w where w.product_id = ${products.id}) as wishlisted
        from ${products}
        left join lateral (
          select sum(pv.views) as views from ${productViews} pv
          where pv.product_id = ${products.id} and pv.day >= ${day(r.from)} and pv.day < ${day(r.to)}
        ) v on true
        left join lateral (
          select count(distinct "vendor_orders"."id") as orders, sum("order_lines"."quantity") as units,
            sum("order_lines"."quantity" * "order_lines"."unit_price_cents") as sales
          from "order_lines"
          join "vendor_orders" on "vendor_orders"."id" = "order_lines"."vendor_order_id"
          join "orders" on "orders"."id" = "vendor_orders"."order_id"
          where "order_lines"."product_id" = ${products.id} and ${SOLD}
            and "orders"."paid_at" >= ${r.from} and "orders"."paid_at" < ${r.to}
        ) s on true
        where ${where}
        order by ${order}, ${products.createdAt} desc
        limit ${page.limit} offset ${page.offset}`),
      db.select({ total: count() }).from(products).where(where),
    ]);
    const list = result.rows as Record<string, unknown>[];
    const ratings = await ratingsFor(db, list.map((x) => String(x.id)));
    return {
      total,
      rows: list.map((x) => {
        const viewCount = Number(x.views);
        const orders = Number(x.orders);
        const rating = ratings.get(String(x.id));
        return {
          productId: String(x.id),
          title: String(x.title),
          slug: String(x.slug),
          price: this.price(Number(x.price)),
          stock: Number(x.stock),
          status: String(x.status),
          views: viewCount,
          orders,
          units: Number(x.units),
          sales: this.price(Number(x.sales)),
          conversionRate: per100(orders, viewCount),
          wishlisted: Number(x.wishlisted),
          rating: { average: rating?.average ?? null, count: rating?.count ?? 0 },
        };
      }),
    };
  }

  /** Account statement: earnings and withdrawals with a running balance. */
  async statement(vendorId: string, q: StatementQueryDto): Promise<StatementDto> {
    const db = this.database.db;
    const r = rangeOf(q, 30, 366);
    const [before, entries] = await Promise.all([ledger(db, vendorId, r.from), ledger(db, vendorId, r.to, r.from)]);
    const opening = before.reduce((s, e) => s + e.amount, 0);
    const sum = (type: string) => entries.filter((e) => e.type === type).reduce((s, e) => s + e.amount, 0);
    let balance = opening;
    const gross = sum('sale');
    const commission = -sum('commission');
    const refunds = -sum('refund');
    const withdrawals = -sum('withdrawal');
    return {
      from: day(r.from),
      to: lastDay(r),
      openingBalance: this.price(opening),
      grossSales: this.price(gross),
      commission: this.price(commission),
      refunds: this.price(refunds),
      netEarnings: this.price(gross - commission - refunds),
      withdrawals: this.price(withdrawals),
      closingBalance: this.price(opening + gross - commission - refunds - withdrawals),
      entries: entries.map((e) => {
        balance += e.amount;
        return {
          at: e.at,
          type: e.type,
          reference: e.reference,
          description: e.description,
          amount: this.price(e.amount),
          balance: this.price(balance),
          status: e.status,
        };
      }),
    };
  }

  /* ---------------- admin ---------------- */

  async adminAnalytics(q: AnalyticsQueryDto): Promise<AdminAnalyticsDto> {
    const db = this.database.db;
    const r = rangeOf(q);
    const prev = previousRange(r);
    const [now, before, peopleNow, peopleBefore, points, signups, vendorsTop, productsTop, categoriesTop, statuses] =
      await Promise.all([
        totals(db, null, r),
        totals(db, null, prev),
        people(db, r),
        people(db, prev),
        series(db, null, r, q.period),
        signupSeries(db, r, q.period),
        topVendors(db, r),
        topProducts(db, null, r),
        topCategories(db, r),
        vendorOrdersByStatus(db, r),
      ]);
    const aov = (t: { sales: number; orders: number }) => (t.orders ? Math.round(t.sales / t.orders) : 0);
    const periods = new Set([...points.map((p) => p.period), ...signups.customers.keys(), ...signups.vendors.keys()]);
    const byPeriod = new Map(points.map((p) => [p.period, p]));
    return {
      from: day(r.from),
      to: lastDay(r),
      gmv: this.money(now.sales, before.sales),
      commission: this.money(now.commission, before.commission),
      orders: this.metric(now.orders, before.orders),
      averageOrder: this.money(aov(now), aov(before)),
      newCustomers: this.metric(peopleNow.newCustomers, peopleBefore.newCustomers),
      newVendors: this.metric(peopleNow.newVendors, peopleBefore.newVendors),
      buyers: this.metric(peopleNow.buyers, peopleBefore.buyers),
      repeatBuyerRate:
        peopleNow.buyers === 0 ? null : Math.round((peopleNow.repeatBuyers / peopleNow.buyers) * 1000) / 10,
      refunds: this.money(now.refunds, before.refunds),
      vendorOrdersByStatus: statuses,
      series: [...periods].sort().map((period) => {
        const p = byPeriod.get(period);
        return {
          period,
          orders: p?.orders ?? 0,
          gmv: this.price(p?.sales ?? 0),
          commission: this.price(p?.commission ?? 0),
          newCustomers: signups.customers.get(period) ?? 0,
          newVendors: signups.vendors.get(period) ?? 0,
        };
      }),
      topVendors: vendorsTop.map((v) => ({ id: v.id, name: v.name, orders: v.orders, sales: this.price(v.sales) })),
      topProducts: productsTop.map((p) => ({ id: p.id, name: p.name, orders: p.orders, sales: this.price(p.sales) })),
      topCategories: categoriesTop.map((c) => ({ id: c.id, name: c.name, orders: c.orders, sales: this.price(c.sales) })),
    };
  }
}
