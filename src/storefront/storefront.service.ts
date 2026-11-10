import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, count, desc, eq, ne } from 'drizzle-orm';
import { type Page, type PaginationQueryDto, toPage } from '../common/pagination.js';
import { Database, type Executor, type Tx } from '../database/database.js';
import { addresses, wishlistItems } from '../database/schema/index.js';
import type { DeliveryAddress } from '../database/schema/index.js';
import { findPublicByIds, imagesFor } from '../products/products.queries.js';
import { ProductsService } from '../products/products.service.js';
import { lockUser } from '../users/users.queries.js';
import {
  MAX_ADDRESSES,
  MAX_WISHLIST,
  type SaveAddressDto,
  type SavedAddressDto,
  type UpdateAddressDto,
  type WishlistItemDto,
  type WishlistStatusDto,
} from './dto/storefront.dto.js';

type AddressRow = typeof addresses.$inferSelect;

/** Customer wishlist and saved addresses. */
@Injectable()
export class StorefrontService {
  constructor(
    private readonly database: Database,
    private readonly products: ProductsService,
  ) {}

  /* ---------------- wishlist ---------------- */

  async wishlist(userId: string, q: PaginationQueryDto): Promise<Page<WishlistItemDto>> {
    const db = this.database.db;
    const where = eq(wishlistItems.userId, userId);
    const [rows, [{ total }]] = await Promise.all([
      db
        .select()
        .from(wishlistItems)
        .where(where)
        .orderBy(desc(wishlistItems.createdAt))
        .limit(q.limit)
        .offset(q.offset),
      db.select({ total: count() }).from(wishlistItems).where(where),
    ]);
    const live = await findPublicByIds(db, rows.map((r) => r.productId));
    const images = await imagesFor(db, live.map((p) => p.id));
    const byId = new Map(live.map((p) => [p.id, p]));
    return toPage(
      await Promise.all(
        rows.map(async (r) => {
          const p = byId.get(r.productId);
          return {
            productId: r.productId,
            product: p ? await this.products.toSummary(p, images.get(p.id) ?? []) : null,
            addedAt: r.createdAt,
          };
        }),
      ),
      total,
      q,
    );
  }

  /** Saving twice changes nothing. Only products on sale can be saved. */
  async save(userId: string, productId: string): Promise<WishlistStatusDto> {
    const [product] = await findPublicByIds(this.database.db, [productId]);
    if (!product) throw new NotFoundException('Product not found');
    await this.database.transaction(async (tx) => {
      await lockUser(tx, userId, 'share');
      const [{ n }] = await tx
        .select({ n: count() })
        .from(wishlistItems)
        .where(eq(wishlistItems.userId, userId));
      if (n >= MAX_WISHLIST && !(await this.isSaved(tx, userId, productId)))
        throw new ConflictException(`A wishlist holds at most ${MAX_WISHLIST} products`);
      await tx.insert(wishlistItems).values({ userId, productId }).onConflictDoNothing();
    });
    return this.status(userId, productId);
  }

  async unsave(userId: string, productId: string): Promise<WishlistStatusDto> {
    await this.database.db
      .delete(wishlistItems)
      .where(and(eq(wishlistItems.userId, userId), eq(wishlistItems.productId, productId)));
    return this.status(userId, productId);
  }

  async status(userId: string, productId: string): Promise<WishlistStatusDto> {
    const db = this.database.db;
    const [saved, [{ n }]] = await Promise.all([
      this.isSaved(db, userId, productId),
      db.select({ n: count() }).from(wishlistItems).where(eq(wishlistItems.productId, productId)),
    ]);
    return { productId, saved, count: n };
  }

  private async isSaved(db: Executor, userId: string, productId: string) {
    return (
      (
        await db
          .select({ productId: wishlistItems.productId })
          .from(wishlistItems)
          .where(and(eq(wishlistItems.userId, userId), eq(wishlistItems.productId, productId)))
          .limit(1)
      ).length > 0
    );
  }

  /* ---------------- addresses ---------------- */

  async addresses(userId: string): Promise<SavedAddressDto[]> {
    const rows = await this.database.db
      .select()
      .from(addresses)
      .where(eq(addresses.userId, userId))
      .orderBy(desc(addresses.isDefault), asc(addresses.createdAt));
    return rows.map(toAddressDto);
  }

  async address(userId: string, id: string): Promise<SavedAddressDto> {
    return toAddressDto(await this.ownedAddress(this.database.db, userId, id));
  }

  async addAddress(userId: string, dto: SaveAddressDto): Promise<SavedAddressDto> {
    const row = await this.database.transaction(async (tx) => {
      await lockUser(tx, userId, 'update');
      const existing = await tx
        .select({ id: addresses.id })
        .from(addresses)
        .where(eq(addresses.userId, userId));
      if (existing.length >= MAX_ADDRESSES)
        throw new ConflictException(`You can save up to ${MAX_ADDRESSES} addresses`);
      const isDefault = existing.length === 0 || dto.isDefault === true;
      if (isDefault) await this.clearDefault(tx, userId);
      const [created] = await tx
        .insert(addresses)
        .values({
          userId,
          isDefault,
          label: dto.label ?? null,
          recipientName: dto.recipientName,
          phone: dto.phone,
          line1: dto.line1,
          line2: dto.line2 ?? null,
          city: dto.city,
          state: dto.state,
          notes: dto.notes ?? null,
        })
        .returning();
      return created;
    });
    return toAddressDto(row);
  }

  async updateAddress(userId: string, id: string, dto: UpdateAddressDto): Promise<SavedAddressDto> {
    const changes = Object.fromEntries(
      Object.entries(fields(dto)).filter(([, v]) => v !== undefined),
    );
    if (Object.keys(changes).length === 0 && dto.isDefault === undefined)
      throw new BadRequestException('No fields to update');
    const row = await this.database.transaction(async (tx) => {
      await lockUser(tx, userId, 'update');
      const current = await this.ownedAddress(tx, userId, id);
      if (dto.isDefault === false && current.isDefault)
        throw new BadRequestException('Choose another address as the default instead');
      if (dto.isDefault === true && !current.isDefault) await this.clearDefault(tx, userId);
      const [updated] = await tx
        .update(addresses)
        .set({ ...changes, ...(dto.isDefault === true && { isDefault: true }) })
        .where(eq(addresses.id, id))
        .returning();
      return updated;
    });
    return toAddressDto(row);
  }

  async setDefault(userId: string, id: string): Promise<SavedAddressDto> {
    return this.updateAddress(userId, id, { isDefault: true });
  }

  /** Deleting the default makes the oldest remaining address the default. */
  async removeAddress(userId: string, id: string): Promise<void> {
    await this.database.transaction(async (tx) => {
      await lockUser(tx, userId, 'update');
      const current = await this.ownedAddress(tx, userId, id);
      await tx.delete(addresses).where(eq(addresses.id, id));
      if (current.isDefault) {
        const [next] = await tx
          .select({ id: addresses.id })
          .from(addresses)
          .where(and(eq(addresses.userId, userId), ne(addresses.id, id)))
          .orderBy(asc(addresses.createdAt))
          .limit(1);
        if (next) await tx.update(addresses).set({ isDefault: true }).where(eq(addresses.id, next.id));
      }
    });
  }

  /** For checkout by `addressId`. */
  async deliveryAddress(db: Executor, userId: string, id: string): Promise<DeliveryAddress> {
    const a = await this.ownedAddress(db, userId, id);
    return {
      recipientName: a.recipientName,
      phone: a.phone,
      line1: a.line1,
      line2: a.line2,
      city: a.city,
      state: a.state,
      notes: a.notes,
    };
  }

  private async ownedAddress(db: Executor, userId: string, id: string): Promise<AddressRow> {
    const [row] = await db
      .select()
      .from(addresses)
      .where(and(eq(addresses.id, id), eq(addresses.userId, userId)))
      .limit(1);
    if (!row) throw new NotFoundException('Address not found');
    return row;
  }

  private clearDefault(tx: Tx, userId: string) {
    return tx
      .update(addresses)
      .set({ isDefault: false })
      .where(and(eq(addresses.userId, userId), eq(addresses.isDefault, true)));
  }
}

const fields = (dto: UpdateAddressDto) => ({
  label: dto.label === undefined ? undefined : dto.label,
  recipientName: dto.recipientName,
  phone: dto.phone,
  line1: dto.line1,
  line2: dto.line2 === undefined ? undefined : dto.line2,
  city: dto.city,
  state: dto.state,
  notes: dto.notes === undefined ? undefined : dto.notes,
});

const toAddressDto = (a: AddressRow): SavedAddressDto => ({
  id: a.id,
  label: a.label,
  recipientName: a.recipientName,
  phone: a.phone,
  line1: a.line1,
  line2: a.line2,
  city: a.city,
  state: a.state,
  notes: a.notes,
  isDefault: a.isDefault,
  createdAt: a.createdAt,
  updatedAt: a.updatedAt,
});
