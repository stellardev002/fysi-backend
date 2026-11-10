import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, count, desc, eq, inArray, isNull, ne, type SQL, sql } from 'drizzle-orm';
import { recordAudit } from '../audit/audit.queries.js';
import { type Page, toPage } from '../common/pagination.js';
import { Database, type Executor, type Tx } from '../database/database.js';
import {
  orderLines,
  products,
  promotionProducts,
  promotions,
  vendorOrders,
} from '../database/schema/index.js';
import { salePrice } from '../products/promotion-price.js';
import { ProductsService } from '../products/products.service.js';
import { lockVendor } from '../vendors/vendors.queries.js';
import {
  type CreatePromotionDto,
  MAX_PROMOTION_DAYS,
  type PromotionDto,
  type PromotionsQueryDto,
  type PromotionState,
  type UpdatePromotionDto,
} from './dto/promotions.dto.js';

type PromotionRow = typeof promotions.$inferSelect;

const DAY_MS = 86_400_000;
/** Active or paused promotions a store can have at once. */
const MAX_OPEN = 20;

export const stateOf = (p: PromotionRow, now = new Date()): PromotionState =>
  p.status === 'ended'
    ? 'ended'
    : p.endsAt <= now
      ? 'expired'
      : p.status === 'paused'
        ? 'paused'
        : p.startsAt > now
          ? 'scheduled'
          : 'running';

const stateWhere = (state: PromotionState): SQL | undefined => {
  switch (state) {
    case 'ended':
      return eq(promotions.status, 'ended');
    case 'expired':
      return sql`${promotions.status} <> 'ended' and ${promotions.endsAt} <= now()`;
    case 'paused':
      return sql`${promotions.status} = 'paused' and ${promotions.endsAt} > now()`;
    case 'scheduled':
      return sql`${promotions.status} = 'active' and ${promotions.startsAt} > now()`;
    case 'running':
      return sql`${promotions.status} = 'active' and ${promotions.startsAt} <= now() and ${promotions.endsAt} > now()`;
  }
};

/** Vendor promotions: automatic percentage-off sales (no codes). */
@Injectable()
export class PromotionsService {
  constructor(
    private readonly database: Database,
    private readonly products: ProductsService,
  ) {}

  async list(vendorId: string, q: PromotionsQueryDto): Promise<Page<PromotionDto>> {
    const db = this.database.db;
    const where = and(eq(promotions.vendorId, vendorId), q.state ? stateWhere(q.state) : undefined);
    const [rows, [{ total }]] = await Promise.all([
      db.select().from(promotions).where(where)
        .orderBy(desc(promotions.startsAt), desc(promotions.id)).limit(q.limit).offset(q.offset),
      db.select({ total: count() }).from(promotions).where(where),
    ]);
    return toPage(await Promise.all(rows.map((r) => this.toDto(db, r))), total, q);
  }

  async get(vendorId: string, id: string): Promise<PromotionDto> {
    const db = this.database.db;
    return this.toDto(db, await this.owned(db, vendorId, id));
  }

  async create(vendorId: string, dto: CreatePromotionDto): Promise<PromotionDto> {
    checkDates(dto.startsAt, dto.endsAt, true);
    const id = await this.database.transaction(async (tx) => {
      await this.sellingVendor(tx, vendorId);
      const [{ n }] = await tx
        .select({ n: count() })
        .from(promotions)
        .where(and(eq(promotions.vendorId, vendorId), ne(promotions.status, 'ended'), sql`${promotions.endsAt} > now()`));
      if (n >= MAX_OPEN)
        throw new ConflictException(`A store can have at most ${MAX_OPEN} promotions at a time`);
      const all = dto.appliesToAll === true;
      if (!all) await this.assertOwnProducts(tx, vendorId, dto.productIds ?? []);
      const [p] = await tx
        .insert(promotions)
        .values({
          vendorId,
          name: dto.name,
          discountBps: dto.discountPercent * 100,
          appliesToAll: all,
          startsAt: dto.startsAt,
          endsAt: dto.endsAt,
        })
        .returning();
      if (!all) await this.setProducts(tx, p.id, dto.productIds!);
      await recordAudit(tx, {
        action: 'promotion.created',
        actorId: vendorId,
        resourceType: 'promotion',
        resourceId: p.id,
        after: { name: p.name, discountBps: p.discountBps, startsAt: p.startsAt, endsAt: p.endsAt },
      });
      return p.id;
    });
    return this.get(vendorId, id);
  }

  async update(vendorId: string, id: string, dto: UpdatePromotionDto): Promise<PromotionDto> {
    if (Object.values(dto).every((v) => v === undefined))
      throw new BadRequestException('No fields to update');
    await this.database.transaction(async (tx) => {
      await this.sellingVendor(tx, vendorId);
      const current = await this.owned(tx, vendorId, id, true);
      const state = stateOf(current);
      if (state === 'ended' || state === 'expired')
        throw new ConflictException('This promotion is over; create a new one');
      // A running sale keeps its start date: it already happened.
      if (dto.startsAt && state === 'running' && dto.startsAt.getTime() !== current.startsAt.getTime())
        throw new ConflictException('This promotion already started; its start date cannot change');
      const startsAt = dto.startsAt ?? current.startsAt;
      const endsAt = dto.endsAt ?? current.endsAt;
      checkDates(startsAt, endsAt, dto.startsAt !== undefined && state !== 'running');
      const all = dto.appliesToAll ?? current.appliesToAll;
      if (!all && dto.productIds) await this.assertOwnProducts(tx, vendorId, dto.productIds);
      if (!all && !dto.productIds && current.appliesToAll)
        throw new BadRequestException('productIds is required when appliesToAll is false');
      await tx
        .update(promotions)
        .set({
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.discountPercent !== undefined && { discountBps: dto.discountPercent * 100 }),
          appliesToAll: all,
          startsAt,
          endsAt,
        })
        .where(eq(promotions.id, id));
      if (all) await tx.delete(promotionProducts).where(eq(promotionProducts.promotionId, id));
      else if (dto.productIds) await this.setProducts(tx, id, dto.productIds);
      await recordAudit(tx, {
        action: 'promotion.updated',
        actorId: vendorId,
        resourceType: 'promotion',
        resourceId: id,
        metadata: { fields: Object.keys(dto).filter((k) => dto[k as keyof UpdatePromotionDto] !== undefined) },
      });
    });
    return this.get(vendorId, id);
  }

  /** pause | resume | end. Ending is final; prices go back at once. */
  async setStatus(vendorId: string, id: string, action: 'pause' | 'resume' | 'end'): Promise<PromotionDto> {
    await this.database.transaction(async (tx) => {
      const current = await this.owned(tx, vendorId, id, true);
      const state = stateOf(current);
      if (state === 'ended' || state === 'expired')
        throw new ConflictException('This promotion is already over');
      if (action === 'pause' && current.status === 'paused')
        throw new ConflictException('This promotion is already paused');
      if (action === 'resume') {
        if (current.status !== 'paused') throw new ConflictException('This promotion is not paused');
        await this.sellingVendor(tx, vendorId);
      }
      const status = action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'ended';
      await tx.update(promotions).set({ status }).where(eq(promotions.id, id));
      await recordAudit(tx, {
        action: `promotion.${action === 'end' ? 'ended' : action === 'pause' ? 'paused' : 'resumed'}`,
        actorId: vendorId,
        resourceType: 'promotion',
        resourceId: id,
      });
    });
    return this.get(vendorId, id);
  }

  /* ---------------- helpers ---------------- */

  private async owned(db: Executor, vendorId: string, id: string, lock = false): Promise<PromotionRow> {
    const query = db
      .select()
      .from(promotions)
      .where(and(eq(promotions.id, id), eq(promotions.vendorId, vendorId)));
    const [row] = lock ? await query.for('update') : await query.limit(1);
    if (!row) throw new NotFoundException('Promotion not found');
    return row;
  }

  private async sellingVendor(tx: Tx, vendorId: string) {
    const vendor = await lockVendor(tx, vendorId);
    if (vendor?.status !== 'approved')
      throw new ForbiddenException('Only a verified, active store can run promotions');
  }

  private async assertOwnProducts(tx: Tx, vendorId: string, ids: string[]) {
    if (ids.length === 0) throw new BadRequestException('Choose at least one product, or set appliesToAll');
    const found = await tx
      .select({ id: products.id })
      .from(products)
      .where(and(inArray(products.id, ids), eq(products.vendorId, vendorId), isNull(products.deletedAt)));
    if (found.length !== ids.length) throw new BadRequestException('productIds must all be your own products');
  }

  private async setProducts(tx: Tx, promotionId: string, ids: string[]) {
    await tx.delete(promotionProducts).where(eq(promotionProducts.promotionId, promotionId));
    await tx.insert(promotionProducts).values(ids.map((productId) => ({ promotionId, productId })));
  }

  private async toDto(db: Executor, p: PromotionRow): Promise<PromotionDto> {
    const [items, [stats]] = await Promise.all([
      p.appliesToAll
        ? Promise.resolve([])
        : db
            .select({ id: products.id, title: products.title, slug: products.slug, priceCents: products.priceCents })
            .from(promotionProducts)
            .innerJoin(products, eq(products.id, promotionProducts.productId))
            .where(and(eq(promotionProducts.promotionId, p.id), isNull(products.deletedAt)))
            .orderBy(products.title),
      db
        .select({
          orders: sql<number>`count(distinct ${vendorOrders.id})::int`,
          units: sql<number>`coalesce(sum(${orderLines.quantity}), 0)::int`,
          revenue: sql<string>`coalesce(sum(${orderLines.unitPriceCents} * ${orderLines.quantity}), 0)`,
          discount: sql<string>`coalesce(sum((${orderLines.listPriceCents} - ${orderLines.unitPriceCents}) * ${orderLines.quantity}), 0)`,
        })
        .from(orderLines)
        .innerJoin(vendorOrders, eq(vendorOrders.id, orderLines.vendorOrderId))
        .where(
          and(
            eq(orderLines.promotionId, p.id),
            ne(vendorOrders.status, 'awaiting_payment'),
            ne(vendorOrders.status, 'cancelled'),
          ),
        ),
    ]);
    return {
      id: p.id,
      name: p.name,
      discountPercent: p.discountBps / 100,
      appliesToAll: p.appliesToAll,
      products: items.map((i) => ({
        id: i.id,
        title: i.title,
        slug: i.slug,
        price: this.products.price(i.priceCents),
        salePrice: this.products.price(salePrice(i.priceCents, p.discountBps)),
      })),
      startsAt: p.startsAt,
      endsAt: p.endsAt,
      state: stateOf(p),
      stats: {
        orders: stats.orders,
        unitsSold: stats.units,
        revenue: this.products.price(Number(stats.revenue)),
        discountGiven: this.products.price(Number(stats.discount)),
      },
      createdAt: p.createdAt,
    };
  }
}

function checkDates(startsAt: Date, endsAt: Date, startIsNew: boolean) {
  if (endsAt <= startsAt) throw new BadRequestException('endsAt must be after startsAt');
  if (endsAt.getTime() <= Date.now()) throw new BadRequestException('endsAt must be in the future');
  // A few minutes of grace for clocks and form filling.
  if (startIsNew && startsAt.getTime() < Date.now() - 10 * 60_000)
    throw new BadRequestException('startsAt cannot be in the past');
  if (endsAt.getTime() - startsAt.getTime() > MAX_PROMOTION_DAYS * DAY_MS)
    throw new BadRequestException(`A promotion can last at most ${MAX_PROMOTION_DAYS} days`);
}
