import { Injectable, type StreamableFile } from '@nestjs/common';
import { and, asc, desc, eq, gte, lt, type SQL, sql } from 'drizzle-orm';
import { csvFile, MAX_EXPORT_ROWS, usd } from '../common/csv.js';
import { type DateRangeQueryDto, rangeOf } from '../common/date-range.js';
import { Database } from '../database/database.js';
import {
  categories,
  newsletterSubscribers,
  orderLines,
  orders,
  payments,
  products,
  type Role,
  supportTickets,
  userSuspensions,
  users,
  vendorOrders,
  vendors,
} from '../database/schema/index.js';
import { vendorOrderWhere, type VendorOrderFilter } from '../orders/orders.queries.js';
import { fromStroops } from '../stellar/amounts.js';
import { AnalyticsService } from './analytics.service.js';

const items = sql<string>`(select string_agg(l.title || ' x' || l.quantity, '; ' order by l.title) from ${orderLines} l where l.vendor_order_id = ${vendorOrders.id})`;

/** `from`/`to` on a column, when given; exports default to everything (capped). */
const between = (col: Parameters<typeof gte>[0], q: DateRangeQueryDto): SQL | undefined => {
  if (!q.from && !q.to) return undefined;
  const r = rangeOf(q, 30, 3660);
  return and(gte(col, r.from), lt(col, r.to));
};

/** CSV downloads for vendors and admins. At most 50,000 rows each. */
@Injectable()
export class ExportsService {
  constructor(
    private readonly database: Database,
    private readonly analytics: AnalyticsService,
  ) {}

  /* ---------------- vendor ---------------- */

  async vendorOrders(vendorId: string, f: VendorOrderFilter): Promise<StreamableFile> {
    const rows = await this.database.db
      .select({ vo: vendorOrders, number: orders.number, paidAt: orders.paidAt, address: orders.deliveryAddress, customer: users.name, items })
      .from(vendorOrders)
      .innerJoin(orders, eq(orders.id, vendorOrders.orderId))
      .innerJoin(users, eq(users.id, orders.customerId))
      .where(vendorOrderWhere(vendorId, f))
      .orderBy(desc(orders.paidAt))
      .limit(MAX_EXPORT_ROWS);
    return csvFile(
      'orders',
      ['Order', 'Paid at', 'Status', 'Payment', 'Customer', 'Items', 'Subtotal (USD)', 'Commission (USD)', 'Payout (USD)', 'Carrier', 'Tracking number', 'Shipped at', 'Delivered at', 'City', 'State', 'Cancel reason'],
      rows.map((r) => [
        r.number, r.paidAt, r.vo.status, r.vo.escrowStatus, r.customer, r.items,
        usd(r.vo.subtotalCents), usd(r.vo.commissionCents), usd(r.vo.payoutCents),
        r.vo.carrier, r.vo.trackingNumber, r.vo.shippedAt, r.vo.deliveredAt,
        r.address.city, r.address.state, r.vo.cancelReason,
      ]),
    );
  }

  async vendorProducts(vendorId: string, q: DateRangeQueryDto): Promise<StreamableFile> {
    const r = rangeOf(q);
    const { rows } = await this.analytics.statsRows(vendorId, r, { limit: MAX_EXPORT_ROWS, offset: 0, sort: 'title' });
    return csvFile(
      'products',
      ['Product ID', 'Title', 'Price (USD)', 'Stock', 'Status', `Views ${q.from ?? 'last 30 days'}`, 'Orders', 'Units sold', 'Sales (USD)', 'Conversion %', 'Wishlisted', 'Rating', 'Reviews'],
      rows.map((p) => [
        p.productId, p.title, p.price.usd, p.stock, p.status, p.views, p.orders, p.units, p.sales.usd,
        p.conversionRate, p.wishlisted, p.rating.average, p.rating.count,
      ]),
    );
  }

  async vendorStatement(vendorId: string, q: DateRangeQueryDto): Promise<StreamableFile> {
    const s = await this.analytics.statement(vendorId, q);
    return csvFile(
      `statement-${s.from}-to-${s.to}`,
      ['Date', 'Type', 'Reference', 'Description', 'Amount (USD)', 'Balance (USD)', 'Status'],
      [
        [s.from, 'opening', '', 'Opening balance', '', s.openingBalance.usd, ''],
        ...s.entries.map((e) => [e.at, e.type, e.reference, e.description, e.amount.usd, e.balance.usd, e.status]),
        [s.to, 'closing', '', 'Closing balance', '', s.closingBalance.usd, ''],
      ],
    );
  }

  /* ---------------- admin ---------------- */

  async users(role: Role | undefined, q: DateRangeQueryDto): Promise<StreamableFile> {
    const rows = await this.database.db
      .select({
        u: users,
        suspended: sql<boolean>`${userSuspensions.userId} is not null`,
      })
      .from(users)
      .leftJoin(userSuspensions, eq(userSuspensions.userId, users.id))
      .where(and(role ? eq(users.role, role) : undefined, between(users.createdAt, q)))
      .orderBy(desc(users.createdAt))
      .limit(MAX_EXPORT_ROWS);
    return csvFile(
      role ? `${role}s` : 'users',
      ['User ID', 'Name', 'Email', 'Role', 'Phone', 'Email verified', '2FA', 'Suspended', 'Deleted at', 'Created at'],
      rows.map(({ u, suspended }) => [
        u.id, u.name, u.email, u.role, u.phone, u.emailVerifiedAt !== null, u.totpEnabledAt !== null, suspended, u.deletedAt, u.createdAt,
      ]),
    );
  }

  async vendors(q: DateRangeQueryDto): Promise<StreamableFile> {
    const rows = await this.database.db
      .select({ v: vendors, email: users.email, owner: users.name, category: categories.name })
      .from(vendors)
      .innerJoin(users, eq(users.id, vendors.userId))
      .leftJoin(categories, eq(categories.id, vendors.categoryId))
      .where(between(vendors.createdAt, q))
      .orderBy(desc(vendors.createdAt))
      .limit(MAX_EXPORT_ROWS);
    return csvFile(
      'vendors',
      ['Vendor ID', 'Business', 'Status', 'Owner', 'Email', 'Phone', 'City', 'State', 'Category', 'CAC number', 'Certifications', 'Founding vendor', 'Submitted at', 'Approved at', 'Created at'],
      rows.map(({ v, email, owner, category }) => [
        v.userId, v.businessName, v.status, owner, email, v.phone, v.city, v.state, category, v.cacNumber,
        v.verifiedCertifications.join(' '), v.foundingVendor, v.submittedAt, v.approvedAt, v.createdAt,
      ]),
    );
  }

  async orders(q: DateRangeQueryDto): Promise<StreamableFile> {
    const rows = await this.database.db
      .select({ vo: vendorOrders, number: orders.number, orderStatus: orders.status, paidAt: orders.paidAt, createdAt: orders.createdAt, customer: users.email, vendor: vendors.businessName, items })
      .from(vendorOrders)
      .innerJoin(orders, eq(orders.id, vendorOrders.orderId))
      .innerJoin(users, eq(users.id, orders.customerId))
      .innerJoin(vendors, eq(vendors.userId, vendorOrders.vendorId))
      .where(between(orders.createdAt, q))
      .orderBy(desc(orders.createdAt))
      .limit(MAX_EXPORT_ROWS);
    return csvFile(
      'orders',
      ['Order', 'Vendor order ID', 'Created at', 'Paid at', 'Order status', 'Fulfilment', 'Escrow', 'Customer', 'Vendor', 'Items', 'Subtotal (USD)', 'Commission (USD)', 'Payout (USD)', 'Tracking', 'Problem', 'Cancel reason'],
      rows.map((r) => [
        r.number, r.vo.id, r.createdAt, r.paidAt, r.orderStatus, r.vo.status, r.vo.escrowStatus, r.customer, r.vendor, r.items,
        usd(r.vo.subtotalCents), usd(r.vo.commissionCents), usd(r.vo.payoutCents), r.vo.trackingNumber, r.vo.problemReason, r.vo.cancelReason,
      ]),
    );
  }

  async payments(q: DateRangeQueryDto): Promise<StreamableFile> {
    const rows = await this.database.db
      .select({ p: payments, number: orders.number })
      .from(payments)
      .leftJoin(orders, eq(orders.id, payments.orderId))
      .where(between(payments.createdAt, q))
      .orderBy(desc(payments.createdAt))
      .limit(MAX_EXPORT_ROWS);
    return csvFile(
      'payments',
      ['Payment ID', 'At', 'Status', 'Order', 'Amount', 'Asset', 'Payer', 'Memo', 'Refundable', 'Transaction hash', 'Ledger', 'Note'],
      rows.map(({ p, number }) => [
        p.id, p.closedAt, p.status, number, fromStroops(p.amountStroops), p.assetId.split(':')[0], p.fromAddress, p.memo,
        fromStroops(p.refundableStroops), p.txHash, p.ledger, p.note,
      ]),
    );
  }

  async products(q: DateRangeQueryDto): Promise<StreamableFile> {
    const rows = await this.database.db
      .select({ p: products, vendor: vendors.businessName, category: categories.name })
      .from(products)
      .innerJoin(vendors, eq(vendors.userId, products.vendorId))
      .innerJoin(categories, eq(categories.id, products.categoryId))
      .where(between(products.createdAt, q))
      .orderBy(desc(products.createdAt))
      .limit(MAX_EXPORT_ROWS);
    return csvFile(
      'products',
      ['Product ID', 'Title', 'Vendor', 'Category', 'Price (USD)', 'Stock', 'Status', 'Moderation', 'Certifications', 'Deleted at', 'Created at'],
      rows.map(({ p, vendor, category }) => [
        p.id, p.title, vendor, category, usd(p.priceCents), p.stock, p.status, p.moderationStatus, p.certifications.join(' '), p.deletedAt, p.createdAt,
      ]),
    );
  }

  async newsletter(q: DateRangeQueryDto): Promise<StreamableFile> {
    const rows = await this.database.db
      .select()
      .from(newsletterSubscribers)
      .where(between(newsletterSubscribers.subscribedAt, q))
      .orderBy(asc(newsletterSubscribers.subscribedAt))
      .limit(MAX_EXPORT_ROWS);
    return csvFile(
      'newsletter',
      ['Email', 'Status', 'Source', 'Has account', 'Subscribed at', 'Unsubscribed at'],
      rows.map((s) => [s.email, s.status, s.source, s.userId !== null, s.subscribedAt, s.unsubscribedAt]),
    );
  }

  async tickets(q: DateRangeQueryDto): Promise<StreamableFile> {
    const rows = await this.database.db
      .select({ t: supportTickets, number: orders.number })
      .from(supportTickets)
      .leftJoin(orders, eq(orders.id, supportTickets.orderId))
      .where(between(supportTickets.createdAt, q))
      .orderBy(desc(supportTickets.createdAt))
      .limit(MAX_EXPORT_ROWS);
    return csvFile(
      'tickets',
      ['Ticket', 'Created at', 'Category', 'Priority', 'Status', 'Subject', 'Name', 'Email', 'Order', 'Last message at', 'Resolved at'],
      rows.map(({ t, number }) => [
        t.number, t.createdAt, t.category, t.priority, t.status, t.subject, t.name, t.email, number, t.lastMessageAt, t.resolvedAt,
      ]),
    );
  }
}
