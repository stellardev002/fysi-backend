import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, count, desc, eq, isNull, notExists, type SQL, sql } from 'drizzle-orm';
import { recordAudit } from '../audit/audit.queries.js';
import type { AuthUser } from '../auth/auth-user.js';
import { type Page, type PaginationQueryDto, toPage } from '../common/pagination.js';
import { Database } from '../database/database.js';
import {
  orderLines,
  orders,
  productReviews,
  products,
  users,
  vendorOrders,
  vendors,
} from '../database/schema/index.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { findPublicBySlug, imagesFor } from '../products/products.queries.js';
import { imageUrl } from '../storage/images.js';
import { ObjectStorage } from '../storage/object-storage.js';
import type {
  AdminReviewDto,
  AdminReviewsQueryDto,
  CreateReviewDto,
  MyReviewDto,
  PendingReviewDto,
  ProductReviewsQueryDto,
  RatingSummaryDto,
  ReviewDto,
  UpdateReviewDto,
  VendorReviewsQueryDto,
} from './dto/reviews.dto.js';
import { ratingOf, shortName } from './reviews.queries.js';

/** The customer received it: delivered, or escrow released after shipping. */
const received = sql`(${vendorOrders.status} = 'delivered' or (${vendorOrders.status} = 'shipped' and ${vendorOrders.escrowStatus} in ('released', 'paid_out')))`;

const ROW = {
  review: productReviews,
  authorName: users.name,
  authorDeleted: sql<boolean>`${users.deletedAt} is not null`,
  customerEmail: users.email,
  productTitle: products.title,
  productSlug: products.slug,
  vendorName: vendors.businessName,
};
type Row = {
  review: typeof productReviews.$inferSelect;
  authorName: string;
  authorDeleted: boolean;
  customerEmail: string;
  productTitle: string;
  productSlug: string;
  vendorName: string | null;
};

/** Verified-purchase product reviews. */
@Injectable()
export class ReviewsService {
  constructor(
    private readonly database: Database,
    private readonly storage: ObjectStorage,
    private readonly notifications: NotificationsService,
  ) {}

  /* ---------------- public ---------------- */

  async forProduct(slug: string, q: ProductReviewsQueryDto): Promise<Page<ReviewDto>> {
    const product = await this.publicProduct(slug);
    const { rows, total } = await this.query(
      and(
        eq(productReviews.productId, product.id),
        eq(productReviews.status, 'visible'),
        q.rating ? eq(productReviews.rating, q.rating) : undefined,
      ),
      q,
    );
    return toPage(rows.map(toPublic), total, q);
  }

  async summary(slug: string): Promise<RatingSummaryDto> {
    return ratingOf(this.database.db, (await this.publicProduct(slug)).id);
  }

  /* ---------------- customer ---------------- */

  /** Delivered items not reviewed yet: the "Rate your purchase" list. */
  async pending(userId: string, q: PaginationQueryDto): Promise<Page<PendingReviewDto>> {
    const db = this.database.db;
    const where = and(
      eq(orders.customerId, userId),
      received,
      isNull(products.deletedAt),
      notExists(
        db.select({ one: sql`1` }).from(productReviews).where(eq(productReviews.orderLineId, orderLines.id)),
      ),
    );
    const base = () =>
      db
        .select({
          line: orderLines,
          number: orders.number,
          slug: products.slug,
          vendorName: vendors.businessName,
          deliveredAt: vendorOrders.deliveredAt,
          shippedAt: vendorOrders.shippedAt,
        })
        .from(orderLines)
        .innerJoin(vendorOrders, eq(vendorOrders.id, orderLines.vendorOrderId))
        .innerJoin(orders, eq(orders.id, vendorOrders.orderId))
        .innerJoin(products, eq(products.id, orderLines.productId))
        .innerJoin(vendors, eq(vendors.userId, vendorOrders.vendorId))
        .where(where);
    const [rows, [{ total }]] = await Promise.all([
      base()
        .orderBy(desc(sql`coalesce(${vendorOrders.deliveredAt}, ${vendorOrders.shippedAt})`), asc(orderLines.id))
        .limit(q.limit)
        .offset(q.offset),
      db
        .select({ total: count() })
        .from(orderLines)
        .innerJoin(vendorOrders, eq(vendorOrders.id, orderLines.vendorOrderId))
        .innerJoin(orders, eq(orders.id, vendorOrders.orderId))
        .innerJoin(products, eq(products.id, orderLines.productId))
        .where(where),
    ]);
    const images = await imagesFor(db, rows.map((r) => r.line.productId));
    return toPage(
      await Promise.all(
        rows.map(async (r) => ({
          orderLineId: r.line.id,
          orderNumber: r.number,
          product: { id: r.line.productId, title: r.line.title, slug: r.slug },
          imageUrl: await imageUrl(this.storage, images.get(r.line.productId)?.[0]?.storageKey ?? null),
          vendorName: r.vendorName,
          quantity: r.line.quantity,
          deliveredAt: r.deliveredAt ?? r.shippedAt,
        })),
      ),
      total,
      q,
    );
  }

  async mine(userId: string, q: PaginationQueryDto): Promise<Page<MyReviewDto>> {
    const { rows, total } = await this.query(eq(productReviews.customerId, userId), { ...q, sort: 'newest' });
    return toPage(rows.map(toMine), total, q);
  }

  async create(user: AuthUser, dto: CreateReviewDto): Promise<MyReviewDto> {
    const id = await this.database.transaction(async (tx) => {
      const [line] = await tx
        .select({
          line: orderLines,
          customerId: orders.customerId,
          vendorId: vendorOrders.vendorId,
          received: sql<boolean>`${received}`,
          productDeleted: sql<boolean>`${products.deletedAt} is not null`,
        })
        .from(orderLines)
        .innerJoin(vendorOrders, eq(vendorOrders.id, orderLines.vendorOrderId))
        .innerJoin(orders, eq(orders.id, vendorOrders.orderId))
        .innerJoin(products, eq(products.id, orderLines.productId))
        .where(eq(orderLines.id, dto.orderLineId))
        .limit(1);
      if (line?.customerId !== user.id) throw new NotFoundException('Order item not found');
      if (!line.received)
        throw new ConflictException('You can review this item once it is delivered');
      if (line.productDeleted) throw new ConflictException('This product is no longer sold');
      const [created] = await tx
        .insert(productReviews)
        .values({
          orderLineId: line.line.id,
          productId: line.line.productId,
          vendorId: line.vendorId,
          customerId: user.id,
          rating: dto.rating,
          title: dto.title ?? null,
          body: dto.body,
        })
        .onConflictDoNothing({ target: productReviews.orderLineId })
        .returning();
      if (!created) throw new ConflictException('You already reviewed this item. Edit your review instead');
      await recordAudit(tx, {
        action: 'review.created',
        actorId: user.id,
        resourceType: 'review',
        resourceId: created.id,
        metadata: { productId: created.productId, rating: created.rating },
      });
      await this.notifications.notify(tx, line.vendorId, {
        kind: 'review.new',
        title: `New ${dto.rating}-star review`,
        body: `${line.line.title}: “${truncate(dto.title ?? dto.body, 80)}”`,
        link: '/vendor/reviews',
        data: { reviewId: created.id, productId: created.productId },
      });
      return created.id;
    });
    return this.mineOne(user.id, id);
  }

  async update(user: AuthUser, id: string, dto: UpdateReviewDto): Promise<MyReviewDto> {
    const changes = Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined));
    if (Object.keys(changes).length === 0) throw new BadRequestException('No fields to update');
    const rows = await this.database.db
      .update(productReviews)
      .set(changes)
      .where(and(eq(productReviews.id, id), eq(productReviews.customerId, user.id)))
      .returning({ id: productReviews.id });
    if (rows.length === 0) throw new NotFoundException('Review not found');
    return this.mineOne(user.id, id);
  }

  async remove(user: AuthUser, id: string): Promise<void> {
    await this.database.transaction(async (tx) => {
      const rows = await tx
        .delete(productReviews)
        .where(and(eq(productReviews.id, id), eq(productReviews.customerId, user.id)))
        .returning({ id: productReviews.id });
      if (rows.length === 0) throw new NotFoundException('Review not found');
      await recordAudit(tx, { action: 'review.deleted', actorId: user.id, resourceType: 'review', resourceId: id });
    });
  }

  /* ---------------- vendor ---------------- */

  async forVendor(vendorId: string, q: VendorReviewsQueryDto): Promise<Page<ReviewDto>> {
    const { rows, total } = await this.query(
      and(
        eq(productReviews.vendorId, vendorId),
        eq(productReviews.status, 'visible'),
        q.productId ? eq(productReviews.productId, q.productId) : undefined,
        q.rating ? eq(productReviews.rating, q.rating) : undefined,
      ),
      q,
    );
    return toPage(rows.map(toPublic), total, q);
  }

  /* ---------------- admin ---------------- */

  async adminList(q: AdminReviewsQueryDto): Promise<Page<AdminReviewDto>> {
    const { rows, total } = await this.query(
      and(
        q.status ? eq(productReviews.status, q.status) : undefined,
        q.productId ? eq(productReviews.productId, q.productId) : undefined,
        q.rating ? eq(productReviews.rating, q.rating) : undefined,
      ),
      q,
    );
    return toPage(rows.map(toAdmin), total, q);
  }

  async moderate(admin: AuthUser, id: string, hide: boolean, reason: string | null): Promise<AdminReviewDto> {
    await this.database.transaction(async (tx) => {
      const [current] = await tx.select().from(productReviews).where(eq(productReviews.id, id)).for('update');
      if (!current) throw new NotFoundException('Review not found');
      if (!hide && current.status !== 'hidden') throw new ConflictException('This review is not hidden');
      await tx
        .update(productReviews)
        .set({
          status: hide ? 'hidden' : 'visible',
          moderationReason: hide ? reason : null,
          moderatedBy: admin.id,
        })
        .where(eq(productReviews.id, id));
      await recordAudit(tx, {
        action: hide ? 'review.hidden' : 'review.unhidden',
        actorId: admin.id,
        resourceType: 'review',
        resourceId: id,
        metadata: { reason },
        before: { status: current.status },
        after: { status: hide ? 'hidden' : 'visible' },
      });
    });
    const { rows } = await this.query(eq(productReviews.id, id), { limit: 1, offset: 0, sort: 'newest' });
    return toAdmin(rows[0]);
  }

  /* ---------------- helpers ---------------- */

  private async publicProduct(slug: string) {
    const product = await findPublicBySlug(this.database.db, slug);
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  private async mineOne(userId: string, id: string): Promise<MyReviewDto> {
    const { rows } = await this.query(
      and(eq(productReviews.id, id), eq(productReviews.customerId, userId)),
      { limit: 1, offset: 0, sort: 'newest' },
    );
    if (!rows[0]) throw new NotFoundException('Review not found');
    return toMine(rows[0]);
  }

  private async query(
    where: SQL | undefined,
    q: { limit: number; offset: number; sort?: 'newest' | 'highest' | 'lowest' },
  ): Promise<{ rows: Row[]; total: number }> {
    const db = this.database.db;
    const order =
      q.sort === 'highest'
        ? [desc(productReviews.rating), desc(productReviews.createdAt)]
        : q.sort === 'lowest'
          ? [asc(productReviews.rating), desc(productReviews.createdAt)]
          : [desc(productReviews.createdAt)];
    const [rows, [{ total }]] = await Promise.all([
      db
        .select(ROW)
        .from(productReviews)
        .innerJoin(users, eq(users.id, productReviews.customerId))
        .innerJoin(products, eq(products.id, productReviews.productId))
        .innerJoin(vendors, eq(vendors.userId, productReviews.vendorId))
        .where(where)
        .orderBy(...order, desc(productReviews.id))
        .limit(q.limit)
        .offset(q.offset),
      db.select({ total: count() }).from(productReviews).where(where),
    ]);
    return { rows, total };
  }
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const toPublic = (r: Row): ReviewDto => ({
  id: r.review.id,
  rating: r.review.rating,
  title: r.review.title,
  body: r.review.body,
  author: r.authorDeleted ? 'Fysi customer' : shortName(r.authorName),
  verifiedPurchase: true,
  product: { id: r.review.productId, title: r.productTitle, slug: r.productSlug },
  createdAt: r.review.createdAt,
  updatedAt: r.review.updatedAt,
});

const toMine = (r: Row): MyReviewDto => ({
  ...toPublic(r),
  status: r.review.status,
  moderationReason: r.review.moderationReason,
  orderLineId: r.review.orderLineId,
});

const toAdmin = (r: Row): AdminReviewDto => ({
  ...toMine(r),
  customerId: r.review.customerId,
  customerEmail: r.customerEmail,
  vendorName: r.vendorName,
});
