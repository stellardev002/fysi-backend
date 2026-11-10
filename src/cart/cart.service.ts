import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { recordAudit } from '../audit/audit.queries.js';
import { Database } from '../database/database.js';
import { lockUser } from '../users/users.queries.js';
import { salePrice } from '../products/promotion-price.js';
import { ProductsService } from '../products/products.service.js';
import {
  findPublicByIds,
  imagesFor,
} from '../products/products.queries.js';
import {
  clearCart,
  deleteCartItem,
  listCart,
  upsertCartItem,
} from './cart.queries.js';
import {
  type CartDto,
  type CartLineDto,
  type GuestCartItemDto,
  MAX_CART_LINES,
  MAX_QUANTITY,
  type MergeResultDto,
} from './dto/cart.dto.js';
import { type Line, planMerge } from './merge.js';

@Injectable()
export class CartService {
  constructor(
    private readonly database: Database,
    private readonly products: ProductsService,
  ) {}

  async get(userId: string): Promise<CartDto> {
    return this.price(await listCart(this.database.db, userId));
  }

  /** Prices a browser cart for a guest, with the same rules as an account cart. */
  preview(items: GuestCartItemDto[]): Promise<CartDto> {
    const merged = new Map<string, number>();
    for (const i of items)
      merged.set(i.productId, Math.max(merged.get(i.productId) ?? 0, i.quantity));
    return this.price(
      [...merged].map(([productId, quantity]) => ({ productId, quantity })),
    );
  }

  async setQuantity(
    userId: string,
    productId: string,
    quantity: number,
  ): Promise<CartDto> {
    const [product] = await findPublicByIds(this.database.db, [productId]);
    if (!product) throw new NotFoundException('Product not found');
    if (product.stock <= 0) throw new ConflictException('This product is sold out');
    if (quantity > product.stock)
      throw new ConflictException(`Only ${product.stock} left in stock`);
    await this.database.transaction(async (tx) => {
      // Serialises cart writes per user so the line cap holds.
      await lockUser(tx, userId, 'share');
      const lines = await listCart(tx, userId);
      if (
        !lines.some((l) => l.productId === productId) &&
        lines.length >= MAX_CART_LINES
      )
        throw new ConflictException(
          `A cart holds at most ${MAX_CART_LINES} different products`,
        );
      await upsertCartItem(tx, userId, productId, quantity);
    });
    return this.get(userId);
  }

  async remove(userId: string, productId: string): Promise<CartDto> {
    await this.database.transaction((tx) =>
      deleteCartItem(tx, userId, productId),
    );
    return this.get(userId);
  }

  async clear(userId: string): Promise<CartDto> {
    await this.database.transaction((tx) => clearCart(tx, userId));
    return this.get(userId);
  }

  /** Guest cart → account cart after sign-up or login (PRD C4, C5). Safe to repeat. */
  async merge(userId: string, guest: GuestCartItemDto[]): Promise<MergeResultDto> {
    const ids = [...new Set(guest.map((g) => g.productId))];
    const available = await findPublicByIds(this.database.db, ids);
    const stock = new Map(available.map((p) => [p.id, p.stock]));
    const skipped = await this.database.transaction(async (tx) => {
      await lockUser(tx, userId, 'update');
      const account = await listCart(tx, userId);
      const plan = planMerge(account, guest, stock, MAX_QUANTITY);
      const newLines = plan.set.filter(
        (s) => !account.some((a) => a.productId === s.productId),
      ).length;
      if (account.length + newLines > MAX_CART_LINES)
        throw new BadRequestException(
          `A cart holds at most ${MAX_CART_LINES} different products`,
        );
      for (const line of plan.set)
        await upsertCartItem(tx, userId, line.productId, line.quantity);
      if (plan.set.length > 0)
        await recordAudit(tx, {
          action: 'cart.merged',
          actorId: userId,
          metadata: { lines: plan.set.length, skipped: plan.skipped.length },
        });
      return plan.skipped;
    });
    return { ...(await this.get(userId)), skipped };
  }

  /** Lines with live prices and stock. Unavailable lines stay listed so the customer sees why. */
  private async price(lines: Line[]): Promise<CartDto> {
    const db = this.database.db;
    const rows = await findPublicByIds(db, lines.map((l) => l.productId));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const images = await imagesFor(db, rows.map((r) => r.id));

    let subtotal = 0;
    let itemCount = 0;
    const vendors = new Set<string>();
    const items: CartLineDto[] = await Promise.all(
      lines.map(async (l) => {
        const p = byId.get(l.productId);
        if (!p)
          return {
            productId: l.productId,
            quantity: l.quantity,
            product: null,
            lineTotal: null,
            maxQuantity: 0,
            issue: 'unavailable' as const,
          };
        const maxQuantity = Math.min(p.stock, MAX_QUANTITY);
        const issue =
          p.stock <= 0
            ? ('out_of_stock' as const)
            : l.quantity > p.stock
              ? ('insufficient_stock' as const)
              : null;
        if (!issue) {
          subtotal += salePrice(p.priceCents, p.discountBps) * l.quantity;
          itemCount += l.quantity;
          vendors.add(p.vendorId);
        }
        return {
          productId: l.productId,
          quantity: l.quantity,
          product: await this.products.toSummary(p, images.get(p.id) ?? []),
          lineTotal: this.products.price(salePrice(p.priceCents, p.discountBps) * l.quantity),
          maxQuantity,
          issue,
        };
      }),
    );
    return {
      items,
      subtotal: this.products.price(subtotal),
      itemCount,
      vendorCount: vendors.size,
      readyForCheckout: items.length > 0 && items.every((i) => !i.issue),
    };
  }
}
