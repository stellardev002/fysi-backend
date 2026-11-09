import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { v7 } from 'uuid';
import { recordAudit } from '../audit/audit.queries.js';
import type { AuthUser } from '../auth/auth-user.js';
import { findCategory } from '../categories/categories.queries.js';
import { type Page, toPage } from '../common/pagination.js';
import { slugify, slugSuffix } from '../common/slug.js';
import { Database, type Tx } from '../database/database.js';
import { checkImage, imageUrl, type UploadedImage } from '../storage/images.js';
import { ObjectStorage } from '../storage/object-storage.js';
import { badgeFor } from '../vendors/onboarding.js';
import { findPublicVendorBySlug, lockVendor } from '../vendors/vendors.queries.js';
import { certificationDtos } from '../vendors/vendors.service.js';
import type { PublicVendorDto } from '../vendors/dto/vendors.dto.js';
import {
  type AdminProductDto,
  AdminProductsQueryDto,
  type CatalogueQueryDto,
  type CreateProductDto,
  MAX_IMAGES,
  type PriceDto,
  type ProductDetailDto,
  type ProductImageDto,
  type ProductSummaryDto,
  type UpdateProductDto,
  type VendorProductDto,
  type VendorProductsQueryDto,
} from './dto/products.dto.js';
import { formatCents } from './pricing.js';
import {
  deleteImage,
  findOwnedProduct,
  findPublicBySlug,
  imagesFor,
  imageStats,
  insertImage,
  insertProduct,
  isPublic,
  listAdmin,
  listPublic,
  listVendorProducts,
  lockOwnedProduct,
  lockProduct,
  type Product,
  type ProductImageRow,
  setImagePosition,
  updateProduct,
} from './products.queries.js';

interface CategoryCols {
  categoryName: string;
  categorySlug: string;
}
interface VendorCols {
  vendorSlug: string | null;
  vendorName: string | null;
  vendorLogoKey: string | null;
  vendorCity: string | null;
  vendorState: string | null;
  vendorCertifications: string[];
}

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    private readonly database: Database,
    private readonly storage: ObjectStorage,
  ) {}

  /* ---------------- pricing ---------------- */

  price(cents: number): PriceDto {
    return { cents, usd: formatCents(cents) };
  }

  /* ---------------- vendor ---------------- */

  async vendorList(
    vendorId: string,
    query: VendorProductsQueryDto,
  ): Promise<Page<VendorProductDto>> {
    const { rows, total } = await this.database.readSnapshot((tx) =>
      listVendorProducts(tx, vendorId, query, query),
    );
    return toPage(await this.toVendorDtos(rows), total, query);
  }

  async vendorGet(vendorId: string, id: string): Promise<VendorProductDto> {
    const row = await findOwnedProduct(this.database.db, vendorId, id);
    if (!row) throw new NotFoundException('Product not found');
    return (await this.toVendorDtos([row]))[0];
  }

  async create(user: AuthUser, dto: CreateProductDto): Promise<VendorProductDto> {
    await this.assertActiveCategory(dto.categoryId);
    const id = await this.database.transaction(async (tx) => {
      const vendor = await this.sellingVendor(tx, user.id);
      this.assertCertifications(dto.certifications ?? [], vendor.verifiedCertifications);
      const product = await insertProduct(tx, {
        vendorId: user.id,
        categoryId: dto.categoryId,
        title: dto.title,
        slug: `${slugify(dto.title, 'product')}-${slugSuffix()}`,
        description: dto.description,
        priceCents: dto.priceCents,
        stock: dto.stock,
        certifications: [...(dto.certifications ?? [])].sort(),
        status: dto.status ?? 'active',
      });
      await recordAudit(tx, {
        action: 'product.created',
        actorId: user.id,
        resourceType: 'product',
        resourceId: product.id,
        after: { title: product.title, priceCents: product.priceCents, stock: product.stock },
      });
      return product.id;
    });
    return this.vendorGet(user.id, id);
  }

  async update(
    user: AuthUser,
    id: string,
    dto: UpdateProductDto,
  ): Promise<VendorProductDto> {
    const changes = Object.fromEntries(
      Object.entries(dto).filter(([, v]) => v !== undefined),
    ) as UpdateProductDto;
    if (Object.keys(changes).length === 0)
      throw new BadRequestException('No fields to update');
    if (changes.categoryId) await this.assertActiveCategory(changes.categoryId);
    await this.database.transaction(async (tx) => {
      const vendor = await this.sellingVendor(tx, user.id);
      const product = await this.owned(tx, user.id, id);
      if (product.moderationStatus === 'removed')
        throw new ConflictException('An admin removed this product; it cannot be edited');
      if (changes.certifications) {
        this.assertCertifications(changes.certifications, vendor.verifiedCertifications);
        changes.certifications = [...changes.certifications].sort();
      }
      const updated = await updateProduct(tx, id, changes);
      await recordAudit(tx, {
        action: 'product.updated',
        actorId: user.id,
        resourceType: 'product',
        resourceId: id,
        before: pick(product, Object.keys(changes)),
        after: pick(updated, Object.keys(changes)),
      });
    });
    return this.vendorGet(user.id, id);
  }

  /** Soft delete: the product disappears for everyone but stays for order history. */
  async remove(user: AuthUser, id: string): Promise<void> {
    await this.database.transaction(async (tx) => {
      await this.owned(tx, user.id, id);
      await updateProduct(tx, id, { deletedAt: new Date() });
      await recordAudit(tx, {
        action: 'product.deleted',
        actorId: user.id,
        resourceType: 'product',
        resourceId: id,
      });
    });
  }

  async addImage(
    user: AuthUser,
    id: string,
    file: UploadedImage | undefined,
  ): Promise<VendorProductDto> {
    const type = checkImage(file, 'image', 'product photo');
    const key = `products/${id}/${v7()}.${type.ext}`;
    await this.storage.put(key, file!.buffer, type.mime);
    try {
      await this.database.transaction(async (tx) => {
        await this.sellingVendor(tx, user.id);
        await this.owned(tx, user.id, id);
        const stats = await imageStats(tx, id);
        if (stats.n >= MAX_IMAGES)
          throw new ConflictException(`At most ${MAX_IMAGES} photos per product`);
        await insertImage(tx, {
          productId: id,
          storageKey: key,
          position: stats.last === null ? 0 : stats.last + 1,
        });
        await recordAudit(tx, {
          action: 'product.image_added',
          actorId: user.id,
          resourceType: 'product',
          resourceId: id,
        });
      });
    } catch (err) {
      await this.deleteObjects([key]);
      throw err;
    }
    return this.vendorGet(user.id, id);
  }

  async removeImage(
    user: AuthUser,
    id: string,
    imageId: string,
  ): Promise<VendorProductDto> {
    const removed = await this.database.transaction(async (tx) => {
      await this.owned(tx, user.id, id);
      const image = await deleteImage(tx, id, imageId);
      if (!image) throw new NotFoundException('Image not found');
      await recordAudit(tx, {
        action: 'product.image_removed',
        actorId: user.id,
        resourceType: 'product',
        resourceId: id,
      });
      return image;
    });
    await this.deleteObjects([removed.storageKey]);
    return this.vendorGet(user.id, id);
  }

  async reorderImages(
    user: AuthUser,
    id: string,
    imageIds: string[],
  ): Promise<VendorProductDto> {
    await this.database.transaction(async (tx) => {
      await this.owned(tx, user.id, id);
      const current = (await imagesFor(tx, [id])).get(id) ?? [];
      const known = new Set(current.map((i) => i.id));
      if (
        imageIds.length !== current.length ||
        !imageIds.every((i) => known.has(i))
      )
        throw new BadRequestException(
          'imageIds must list every image of the product exactly once',
        );
      for (const [position, imageId] of imageIds.entries())
        await setImagePosition(tx, id, imageId, position);
    });
    return this.vendorGet(user.id, id);
  }

  /* ---------------- public ---------------- */

  async catalogue(query: CatalogueQueryDto): Promise<Page<ProductSummaryDto>> {
    if (
      query.minPriceCents !== undefined &&
      query.maxPriceCents !== undefined &&
      query.minPriceCents > query.maxPriceCents
    )
      throw new BadRequestException('minPriceCents is above maxPriceCents');
    if (query.sort === 'relevance' && !query.q)
      throw new BadRequestException('sort=relevance needs q');
    const { rows, total } = await this.database.readSnapshot((tx) =>
      listPublic(tx, query, query),
    );
    const images = await imagesFor(this.database.db, rows.map((r) => r.id));
    return toPage(
      await Promise.all(
        rows.map((r) => this.toSummary(r, images.get(r.id) ?? [])),
      ),
      total,
      query,
    );
  }

  async productPage(slug: string): Promise<ProductDetailDto> {
    const row = await findPublicBySlug(this.database.db, slug);
    if (!row) throw new NotFoundException('Product not found');
    const images = await imagesFor(this.database.db, [row.id]);
    const list = images.get(row.id) ?? [];
    const summary = await this.toSummary(row, list);
    return {
      ...summary,
      description: row.description,
      stock: row.stock,
      images: await this.toImages(list),
      vendor: {
        ...summary.vendor,
        logoUrl: await imageUrl(this.storage, row.vendorLogoKey),
        city: row.vendorCity,
        state: row.vendorState,
      },
    };
  }

  async storefront(slug: string): Promise<PublicVendorDto> {
    const found = await findPublicVendorBySlug(this.database.db, slug);
    if (!found) throw new NotFoundException('Store not found');
    const v = found.vendor;
    return {
      slug: v.slug!,
      businessName: v.businessName!,
      description: v.description,
      logoUrl: await imageUrl(this.storage, v.logoKey),
      city: v.city,
      state: v.state,
      category:
        found.categoryName && found.categorySlug && v.categoryId
          ? { id: v.categoryId, name: found.categoryName, slug: found.categorySlug }
          : null,
      badge: badgeFor(v.verifiedCertifications),
      certifications: certificationDtos(v.verifiedCertifications),
      productCount: found.productCount,
      verifiedSince: v.approvedAt!,
    };
  }

  /* ---------------- admin ---------------- */

  async adminList(
    query: AdminProductsQueryDto & { productId?: string },
  ): Promise<Page<AdminProductDto>> {
    const { rows, total } = await this.database.readSnapshot((tx) =>
      listAdmin(tx, query, query),
    );
    const dtos = await this.toVendorDtos(rows, rows.map((r) => r.isPublic));
    return toPage(
      dtos.map((d, i) => ({
        ...d,
        vendorId: rows[i].vendorId,
        vendorName: rows[i].vendorName,
        vendorSlug: rows[i].vendorSlug,
        deletedAt: rows[i].deletedAt,
      })),
      total,
      query,
    );
  }

  /** hide | unhide | remove (PRD A5). `removed` is final. */
  async moderate(
    admin: AuthUser,
    id: string,
    action: 'hide' | 'unhide' | 'remove',
    reason: string | null,
  ): Promise<AdminProductDto> {
    await this.database.transaction(async (tx) => {
      const product = await lockProduct(tx, id);
      if (!product) throw new NotFoundException('Product not found');
      if (product.moderationStatus === 'removed')
        throw new ConflictException('This product was removed; that is final');
      const to = action === 'hide' ? 'hidden' : action === 'remove' ? 'removed' : 'visible';
      if (action === 'unhide' && product.moderationStatus !== 'hidden')
        throw new ConflictException('This product is not hidden');
      await updateProduct(tx, id, {
        moderationStatus: to,
        moderationReason: action === 'unhide' ? null : reason,
        moderatedBy: admin.id,
        moderatedAt: new Date(),
      });
      await recordAudit(tx, {
        action: `product.${action === 'unhide' ? 'unhidden' : to}`,
        actorId: admin.id,
        resourceType: 'product',
        resourceId: id,
        metadata: { reason },
        before: { moderationStatus: product.moderationStatus },
        after: { moderationStatus: to },
      });
    });
    const page = await this.adminList(
      Object.assign(new AdminProductsQueryDto(), {
        productId: id,
        includeDeleted: true,
      }),
    );
    return page.result[0];
  }

  /* ---------------- mapping ---------------- */

  async toSummary(
    r: Product & CategoryCols & VendorCols,
    images: ProductImageRow[],
  ): Promise<ProductSummaryDto> {
    return {
      id: r.id,
      slug: r.slug,
      title: r.title,
      price: this.price(r.priceCents),
      inStock: r.stock > 0,
      imageUrl: images[0] ? await imageUrl(this.storage, images[0].storageKey) : null,
      badge: badgeFor(r.certifications),
      certifications: certificationDtos(r.certifications),
      category: { id: r.categoryId, name: r.categoryName, slug: r.categorySlug },
      vendor: {
        slug: r.vendorSlug!,
        businessName: r.vendorName!,
        verified: true,
        badge: badgeFor(r.vendorCertifications),
      },
      createdAt: r.createdAt,
    };
  }

  private async toImages(list: ProductImageRow[]): Promise<ProductImageDto[]> {
    return Promise.all(
      list.map(async (i) => ({
        id: i.id,
        url: await imageUrl(this.storage, i.storageKey),
        position: i.position,
      })),
    );
  }

  private async toVendorDtos(
    rows: (Product & CategoryCols)[],
    publicFlags?: boolean[],
  ): Promise<VendorProductDto[]> {
    const db = this.database.db;
    const [images, flags] = await Promise.all([
      imagesFor(db, rows.map((r) => r.id)),
      publicFlags ?? Promise.all(rows.map((r) => isPublic(db, r.id))),
    ]);
    return Promise.all(
      rows.map(async (r, i) => ({
        id: r.id,
        slug: r.slug,
        title: r.title,
        description: r.description,
        price: this.price(r.priceCents),
        stock: r.stock,
        category: { id: r.categoryId, name: r.categoryName, slug: r.categorySlug },
        certifications: certificationDtos(r.certifications),
        badge: badgeFor(r.certifications),
        status: r.status,
        moderationStatus: r.moderationStatus,
        moderationReason: r.moderationReason,
        isPublic: flags[i],
        images: await this.toImages(images.get(r.id) ?? []),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    );
  }

  /* ---------------- guards ---------------- */

  /** Only an approved store lists or edits products (PRD: approved → list products). */
  private async sellingVendor(tx: Tx, vendorId: string) {
    const vendor = await lockVendor(tx, vendorId);
    if (!vendor) throw new NotFoundException('Vendor profile not found');
    if (vendor.status !== 'approved')
      throw new ForbiddenException(
        vendor.status === 'suspended'
          ? 'Your store is suspended; products cannot be changed'
          : 'Your business must be verified before you can list products',
      );
    return vendor;
  }

  private async owned(tx: Tx, vendorId: string, id: string): Promise<Product> {
    const product = await lockOwnedProduct(tx, vendorId, id);
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  private assertCertifications(claimed: readonly string[], verified: readonly string[]) {
    const unverified = claimed.filter((c) => !verified.includes(c));
    if (unverified.length > 0)
      throw new BadRequestException(
        `Your store is not verified for: ${unverified.join(', ')}`,
      );
  }

  private async assertActiveCategory(id: string) {
    const category = await findCategory(this.database.db, id);
    if (!category?.isActive)
      throw new BadRequestException('categoryId is not an active category');
  }

  private async deleteObjects(keys: string[]) {
    try {
      await this.storage.delete(keys);
    } catch (err) {
      this.logger.warn({ err, keys }, 'Could not delete stored file');
    }
  }
}

const pick = (row: object, keys: string[]) =>
  Object.fromEntries(
    Object.entries(row).filter(([k]) => keys.includes(k)),
  ) as Record<string, unknown>;
