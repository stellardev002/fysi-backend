import { type SQL, sql } from 'drizzle-orm';
import type { Executor } from '../database/database.js';
import {
  categories,
  orderLines,
  orders,
  productViews,
  products,
  users,
  vendorOrders,
  vendors,
  withdrawals,
} from '../database/schema/index.js';
import type { Range } from '../common/date-range.js';

/** A vendor order that counts as a sale: paid, and not cancelled with a refund. */
export const SOLD = sql`(${vendorOrders.status} <> 'awaiting_payment' and ${vendorOrders.escrowStatus} not in ('void', 'pending', 'refunded'))`;

const day = (d: Date) => d.toISOString().slice(0, 10);
const inRange = (col: SQL | unknown, r: Range) => sql`${col} >= ${r.from} and ${col} < ${r.to}`;

async function rows<T>(db: Executor, query: SQL): Promise<T[]> {
  return (await db.execute(query)).rows as T[];
}

const num = (v: unknown) => Number(v ?? 0);

/** null = the whole marketplace. */
const ofVendor = (vendorId: string | null) =>
  vendorId ? sql`and ${vendorOrders.vendorId} = ${vendorId}` : sql``;

export interface Totals {
  orders: number;
  sales: number;
  net: number;
  commission: number;
  units: number;
  refunds: number;
}

export async function totals(db: Executor, vendorId: string | null, r: Range): Promise<Totals> {
  const [[t], [u], [rf]] = await Promise.all([
    rows<Record<string, unknown>>(
      db,
      sql`select count(*) as orders, coalesce(sum(${vendorOrders.subtotalCents}), 0) as sales,
        coalesce(sum(${vendorOrders.payoutCents}), 0) as net, coalesce(sum(${vendorOrders.commissionCents}), 0) as commission
      from ${vendorOrders} join ${orders} on ${orders.id} = ${vendorOrders.orderId}
      where ${SOLD} ${ofVendor(vendorId)} and ${inRange(orders.paidAt, r)}`,
    ),
    rows<Record<string, unknown>>(
      db,
      sql`select coalesce(sum(${orderLines.quantity}), 0) as units
      from ${orderLines} join ${vendorOrders} on ${vendorOrders.id} = ${orderLines.vendorOrderId}
      join ${orders} on ${orders.id} = ${vendorOrders.orderId}
      where ${SOLD} ${ofVendor(vendorId)} and ${inRange(orders.paidAt, r)}`,
    ),
    rows<Record<string, unknown>>(
      db,
      sql`select coalesce(sum(${vendorOrders.subtotalCents}), 0) as refunds from ${vendorOrders}
      where ${vendorOrders.escrowStatus} = 'refunded' ${ofVendor(vendorId)} and ${inRange(vendorOrders.cancelledAt, r)}`,
    ),
  ]);
  return {
    orders: num(t.orders),
    sales: num(t.sales),
    net: num(t.net),
    commission: num(t.commission),
    units: num(u.units),
    refunds: num(rf.refunds),
  };
}

export async function views(db: Executor, vendorId: string, r: Range): Promise<number> {
  const [v] = await rows<Record<string, unknown>>(
    db,
    sql`select coalesce(sum(${productViews.views}), 0) as views from ${productViews}
      join ${products} on ${products.id} = ${productViews.productId}
      where ${products.vendorId} = ${vendorId} and ${productViews.day} >= ${day(r.from)} and ${productViews.day} < ${day(r.to)}`,
  );
  return num(v.views);
}

const bucket = (period: string, col: unknown) =>
  sql`to_char(date_trunc(${period}, ${col} at time zone 'utc'), 'YYYY-MM-DD')`;

export interface SeriesRow {
  period: string;
  orders: number;
  sales: number;
  net: number;
  commission: number;
  units: number;
}

export async function series(
  db: Executor,
  vendorId: string | null,
  r: Range,
  period: 'day' | 'week' | 'month',
  productId?: string,
): Promise<SeriesRow[]> {
  const [money, units] = await Promise.all([
    rows<Record<string, unknown>>(
      db,
      sql`select ${bucket(period, orders.paidAt)} as period, count(*) as orders,
        coalesce(sum(${vendorOrders.subtotalCents}), 0) as sales, coalesce(sum(${vendorOrders.payoutCents}), 0) as net,
        coalesce(sum(${vendorOrders.commissionCents}), 0) as commission
      from ${vendorOrders} join ${orders} on ${orders.id} = ${vendorOrders.orderId}
      where ${SOLD} ${ofVendor(vendorId)} and ${inRange(orders.paidAt, r)}
      group by 1 order by 1`,
    ),
    rows<Record<string, unknown>>(
      db,
      sql`select ${bucket(period, orders.paidAt)} as period, coalesce(sum(${orderLines.quantity}), 0) as units,
        coalesce(sum(${orderLines.quantity} * ${orderLines.unitPriceCents}), 0) as line_sales
      from ${orderLines} join ${vendorOrders} on ${vendorOrders.id} = ${orderLines.vendorOrderId}
      join ${orders} on ${orders.id} = ${vendorOrders.orderId}
      where ${SOLD} ${ofVendor(vendorId)} and ${inRange(orders.paidAt, r)}
        ${productId ? sql`and ${orderLines.productId} = ${productId}` : sql``}
      group by 1 order by 1`,
    ),
  ]);
  const out = new Map<string, SeriesRow>();
  const at = (p: string) => {
    let row = out.get(p);
    if (!row) out.set(p, (row = { period: p, orders: 0, sales: 0, net: 0, commission: 0, units: 0 }));
    return row;
  };
  if (productId) {
    // For one product: units and its own line sales; orders = orders containing it.
    const orderCounts = await rows<Record<string, unknown>>(
      db,
      sql`select ${bucket(period, orders.paidAt)} as period, count(distinct ${vendorOrders.id}) as orders
        from ${orderLines} join ${vendorOrders} on ${vendorOrders.id} = ${orderLines.vendorOrderId}
        join ${orders} on ${orders.id} = ${vendorOrders.orderId}
        where ${SOLD} ${ofVendor(vendorId)} and ${inRange(orders.paidAt, r)} and ${orderLines.productId} = ${productId}
        group by 1`,
    );
    for (const u of units) {
      const row = at(String(u.period));
      row.units = num(u.units);
      row.sales = num(u.line_sales);
    }
    for (const o of orderCounts) at(String(o.period)).orders = num(o.orders);
  } else {
    for (const m of money) {
      const row = at(String(m.period));
      row.orders = num(m.orders);
      row.sales = num(m.sales);
      row.net = num(m.net);
      row.commission = num(m.commission);
    }
    for (const u of units) at(String(u.period)).units = num(u.units);
  }
  return [...out.values()].sort((a, b) => a.period.localeCompare(b.period));
}

export async function topProducts(db: Executor, vendorId: string | null, r: Range, limit = 10) {
  return (
    await rows<Record<string, unknown>>(
      db,
      sql`select ${orderLines.productId} as id, max(${products.title}) as name,
        count(distinct ${vendorOrders.id}) as orders, sum(${orderLines.quantity}) as units,
        sum(${orderLines.quantity} * ${orderLines.unitPriceCents}) as sales
      from ${orderLines} join ${vendorOrders} on ${vendorOrders.id} = ${orderLines.vendorOrderId}
      join ${orders} on ${orders.id} = ${vendorOrders.orderId}
      join ${products} on ${products.id} = ${orderLines.productId}
      where ${SOLD} ${ofVendor(vendorId)} and ${inRange(orders.paidAt, r)}
      group by ${orderLines.productId} order by sales desc, units desc limit ${limit}`,
    )
  ).map((x) => ({ id: String(x.id), name: String(x.name), orders: num(x.orders), units: num(x.units), sales: num(x.sales) }));
}

export async function topVendors(db: Executor, r: Range, limit = 10) {
  return (
    await rows<Record<string, unknown>>(
      db,
      sql`select ${vendorOrders.vendorId} as id, max(${vendors.businessName}) as name, count(*) as orders,
        sum(${vendorOrders.subtotalCents}) as sales
      from ${vendorOrders} join ${orders} on ${orders.id} = ${vendorOrders.orderId}
      join ${vendors} on ${vendors.userId} = ${vendorOrders.vendorId}
      where ${SOLD} and ${inRange(orders.paidAt, r)}
      group by ${vendorOrders.vendorId} order by sales desc limit ${limit}`,
    )
  ).map((x) => ({ id: String(x.id), name: String(x.name ?? 'Vendor'), orders: num(x.orders), sales: num(x.sales) }));
}

export async function topCategories(db: Executor, r: Range, limit = 10) {
  return (
    await rows<Record<string, unknown>>(
      db,
      sql`select ${categories.id} as id, max(${categories.name}) as name, count(distinct ${vendorOrders.id}) as orders,
        sum(${orderLines.quantity} * ${orderLines.unitPriceCents}) as sales
      from ${orderLines} join ${vendorOrders} on ${vendorOrders.id} = ${orderLines.vendorOrderId}
      join ${orders} on ${orders.id} = ${vendorOrders.orderId}
      join ${products} on ${products.id} = ${orderLines.productId}
      join ${categories} on ${categories.id} = ${products.categoryId}
      where ${SOLD} and ${inRange(orders.paidAt, r)}
      group by ${categories.id} order by sales desc limit ${limit}`,
    )
  ).map((x) => ({ id: String(x.id), name: String(x.name), orders: num(x.orders), sales: num(x.sales) }));
}

/** Marketplace-wide: sign-ups, buyers and repeat buyers in a range. */
export async function people(db: Executor, r: Range) {
  const [[c], [v], [b]] = await Promise.all([
    rows<Record<string, unknown>>(
      db,
      sql`select count(*) as n from ${users} where ${users.role} = 'customer' and ${inRange(users.createdAt, r)}`,
    ),
    rows<Record<string, unknown>>(
      db,
      sql`select count(*) as n from ${vendors} where ${inRange(vendors.approvedAt, r)}`,
    ),
    rows<Record<string, unknown>>(
      db,
      sql`select count(distinct o.customer_id) as buyers,
        count(distinct o.customer_id) filter (where exists (
          select 1 from ${orders} p where p.customer_id = o.customer_id and p.paid_at < ${r.from})) as repeat
      from ${orders} o where o.paid_at >= ${r.from} and o.paid_at < ${r.to}`,
    ),
  ]);
  return { newCustomers: num(c.n), newVendors: num(v.n), buyers: num(b.buyers), repeatBuyers: num(b.repeat) };
}

export async function signupSeries(db: Executor, r: Range, period: string) {
  const [c, v] = await Promise.all([
    rows<Record<string, unknown>>(
      db,
      sql`select ${bucket(period, users.createdAt)} as period, count(*) as n from ${users}
        where ${users.role} = 'customer' and ${inRange(users.createdAt, r)} group by 1`,
    ),
    rows<Record<string, unknown>>(
      db,
      sql`select ${bucket(period, vendors.approvedAt)} as period, count(*) as n from ${vendors}
        where ${inRange(vendors.approvedAt, r)} group by 1`,
    ),
  ]);
  return {
    customers: new Map(c.map((x) => [String(x.period), num(x.n)])),
    vendors: new Map(v.map((x) => [String(x.period), num(x.n)])),
  };
}

export async function vendorOrdersByStatus(db: Executor, r: Range) {
  const list = await rows<Record<string, unknown>>(
    db,
    sql`select ${vendorOrders.status} as status, count(*) as n from ${vendorOrders}
      where ${inRange(vendorOrders.createdAt, r)} group by 1`,
  );
  return Object.fromEntries(list.map((x) => [String(x.status), num(x.n)]));
}

/* ---------------- statements ---------------- */

export interface LedgerRow {
  at: Date;
  type: 'sale' | 'commission' | 'refund' | 'withdrawal';
  reference: string;
  description: string;
  amount: number;
  status: string;
}

/** Earnings entries for a vendor: sales, commission, refunds and withdrawals. */
export async function ledger(db: Executor, vendorId: string, until: Date, from?: Date): Promise<LedgerRow[]> {
  const since = from ?? new Date(0);
  const [sales, refunds, outs] = await Promise.all([
    rows<Record<string, unknown>>(
      db,
      sql`select ${orders.paidAt} as at, ${orders.number} as ref, ${vendorOrders.subtotalCents} as subtotal,
        ${vendorOrders.commissionCents} as commission, ${vendorOrders.commissionBps} as bps, ${vendorOrders.escrowStatus} as escrow,
        (select string_agg(l.title || ' × ' || l.quantity, ', ' order by l.title) from ${orderLines} l where l.vendor_order_id = ${vendorOrders.id}) as items
      from ${vendorOrders} join ${orders} on ${orders.id} = ${vendorOrders.orderId}
      where ${vendorOrders.vendorId} = ${vendorId} and ${orders.paidAt} is not null
        and ${vendorOrders.escrowStatus} not in ('void', 'pending')
        and ${orders.paidAt} >= ${since} and ${orders.paidAt} < ${until}`,
    ),
    rows<Record<string, unknown>>(
      db,
      sql`select ${vendorOrders.cancelledAt} as at, ${orders.number} as ref, ${vendorOrders.payoutCents} as payout,
        ${vendorOrders.cancelReason} as reason
      from ${vendorOrders} join ${orders} on ${orders.id} = ${vendorOrders.orderId}
      where ${vendorOrders.vendorId} = ${vendorId} and ${vendorOrders.escrowStatus} = 'refunded'
        and ${orders.paidAt} is not null and ${vendorOrders.cancelledAt} >= ${since} and ${vendorOrders.cancelledAt} < ${until}`,
    ),
    rows<Record<string, unknown>>(
      db,
      sql`select ${withdrawals.createdAt} as at, ${withdrawals.memo} as ref, ${withdrawals.amountCents} as cents,
        ${withdrawals.destination} as destination, ${withdrawals.status} as status
      from ${withdrawals}
      where ${withdrawals.userId} = ${vendorId} and ${withdrawals.state} = 'confirmed' and ${withdrawals.status} <> 'failed'
        and ${withdrawals.createdAt} >= ${since} and ${withdrawals.createdAt} < ${until}`,
    ),
  ]);
  const out: LedgerRow[] = [];
  for (const s of sales) {
    const at = new Date(String(s.at instanceof Date ? s.at.toISOString() : s.at));
    out.push({
      at,
      type: 'sale',
      reference: String(s.ref),
      description: `Sale: ${String(s.items ?? '')}`,
      amount: num(s.subtotal),
      status: String(s.escrow),
    });
    if (num(s.commission) > 0)
      out.push({
        at,
        type: 'commission',
        reference: String(s.ref),
        description: `Fysi commission (${num(s.bps) / 100}%)`,
        amount: -num(s.commission),
        status: String(s.escrow),
      });
  }
  for (const r of refunds)
    out.push({
      at: new Date(String(r.at instanceof Date ? r.at.toISOString() : r.at)),
      type: 'refund',
      reference: String(r.ref),
      description: `Refunded to the customer${r.reason ? `: ${String(r.reason)}` : ''} (commission returned)`,
      amount: -num(r.payout),
      status: 'refunded',
    });
  for (const w of outs)
    out.push({
      at: new Date(String(w.at instanceof Date ? w.at.toISOString() : w.at)),
      type: 'withdrawal',
      reference: String(w.ref),
      description: `Withdrawal to ${String(w.destination).slice(0, 4)}…${String(w.destination).slice(-4)}`,
      amount: -num(w.cents),
      status: String(w.status),
    });
  const order = { sale: 0, commission: 1, refund: 2, withdrawal: 3 };
  return out.sort((a, b) => a.at.getTime() - b.at.getTime() || order[a.type] - order[b.type]);
}
