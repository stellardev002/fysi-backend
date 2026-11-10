import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { trim } from '../../auth/dto/auth.dto.js';
import { PaginationQueryDto } from '../../common/pagination.js';
import {
  BADGES,
  type Badge,
  CERTIFICATIONS,
  type Certification,
  moderationStatusEnum,
  type ModerationStatus,
  productStatusEnum,
  type ProductStatus,
} from '../../database/schema/index.js';
import {
  CategoryRefDto,
  CertificationDto,
} from '../../vendors/dto/vendors.dto.js';

/** Highest price a product can carry: $100,000. */
export const MAX_PRICE_CENTS = 10_000_000;
export const MAX_STOCK = 100_000;
export const MAX_IMAGES = 8;

const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

export class ProductImageDto {
  @ApiProperty({ format: 'uuid' }) id: string;

  @ApiProperty({
    nullable: true,
    description:
      'Presigned link; it expires, so refetch rather than store it. Null if storage is unavailable.',
  })
  url: string | null;

  @ApiProperty({ example: 0, description: 'Display order; 0 is the cover.' })
  position: number;
}

export class PriceDto {
  @ApiProperty({
    example: 1250,
    description: 'US cents ($1 = 100). Paid 1:1 in USDC on Stellar.',
  })
  cents: number;

  @ApiProperty({ example: '12.50', description: 'US dollars, 2 decimals.' })
  usd: string;
}

/** The vendor's own view of a product. */
export class VendorProductDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'organic-cotton-tote-bag-k3x9qa' }) slug: string;
  @ApiProperty({ example: 'Organic cotton tote bag' }) title: string;
  @ApiProperty() description: string;
  @ApiProperty({ type: PriceDto }) price: PriceDto;
  @ApiProperty({ example: 40 }) stock: number;
  @ApiProperty({ type: CategoryRefDto }) category: CategoryRefDto;
  @ApiProperty({ type: [CertificationDto] }) certifications: CertificationDto[];
  @ApiProperty({ enum: BADGES }) badge: Badge;

  @ApiProperty({
    enum: productStatusEnum.enumValues,
    description: '`hidden` by the vendor.',
  })
  status: ProductStatus;

  @ApiProperty({
    enum: moderationStatusEnum.enumValues,
    description: '`hidden` or `removed` by an admin (see `moderationReason`).',
  })
  moderationStatus: ModerationStatus;

  @ApiProperty({ nullable: true }) moderationReason: string | null;

  @ApiProperty({
    description:
      'Customers can see it now: active, not moderated, and the store is approved.',
  })
  isPublic: boolean;

  @ApiProperty({ type: [ProductImageDto] }) images: ProductImageDto[];
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}

export class CreateProductDto {
  @ApiProperty({ example: 'Organic cotton tote bag', minLength: 3, maxLength: 120 })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  title: string;

  @ApiProperty({
    example: 'Hand-stitched from GOTS-certified cotton. Holds 15 kg.',
    minLength: 20,
    maxLength: 5000,
  })
  @Transform(trim)
  @IsString()
  @MinLength(20)
  @MaxLength(5000)
  description: string;

  @ApiProperty({
    example: 1250,
    description: 'Price in US cents: $12.50 = 1250. Integer, at least $0.50.',
  })
  @IsInt()
  @Min(50)
  @Max(MAX_PRICE_CENTS)
  priceCents: number;

  @ApiProperty({ example: 40, minimum: 0, maximum: MAX_STOCK })
  @IsInt()
  @Min(0)
  @Max(MAX_STOCK)
  stock: number;

  @ApiProperty({ format: 'uuid', description: 'An active category.' })
  @IsUUID()
  categoryId: string;

  @ApiPropertyOptional({
    enum: CERTIFICATIONS,
    isArray: true,
    default: [],
    description:
      "Labels this product carries; each must be one of the store's verified certifications. With one or more the product shows **Certified**, otherwise **Fysi Reviewed**.",
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(CERTIFICATIONS.length)
  @IsIn(CERTIFICATIONS, { each: true })
  certifications?: Certification[];

  @ApiPropertyOptional({
    enum: productStatusEnum.enumValues,
    default: 'active',
    description: 'Create as `hidden` to finish photos before customers see it.',
  })
  @IsOptional()
  @IsIn(productStatusEnum.enumValues)
  status?: ProductStatus;
}

export class UpdateProductDto {
  @ApiPropertyOptional({ minLength: 3, maxLength: 120 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  title?: string;

  @ApiPropertyOptional({ minLength: 20, maxLength: 5000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(20)
  @MaxLength(5000)
  description?: string;

  @ApiPropertyOptional({ example: 1250 })
  @IsOptional()
  @IsInt()
  @Min(50)
  @Max(MAX_PRICE_CENTS)
  priceCents?: number;

  @ApiPropertyOptional({ example: 35 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_STOCK)
  stock?: number;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ enum: CERTIFICATIONS, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(CERTIFICATIONS.length)
  @IsIn(CERTIFICATIONS, { each: true })
  certifications?: Certification[];

  @ApiPropertyOptional({
    enum: productStatusEnum.enumValues,
    description: '`hidden` takes it off the storefront; `active` puts it back.',
  })
  @IsOptional()
  @IsIn(productStatusEnum.enumValues)
  status?: ProductStatus;
}

export class ImageOrderDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    description: 'Every image id of the product, in the new order. The first is the cover.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_IMAGES)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  imageIds: string[];
}

export class VendorProductsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: productStatusEnum.enumValues })
  @IsOptional()
  @IsIn(productStatusEnum.enumValues)
  status?: ProductStatus;

  @ApiPropertyOptional({ description: 'Matches the title.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}

/* ---------------- public ---------------- */

export const SORTS = ['relevance', 'newest', 'price_asc', 'price_desc'] as const;

export class CatalogueQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    example: 'bamboo toothbrush',
    description:
      'Keywords over title and description; quotes and `-word` work as in web search.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ example: 'household', description: 'Category slug.' })
  @IsOptional()
  @Matches(/^[a-z0-9-]{1,60}$/)
  category?: string;

  @ApiPropertyOptional({
    example: 'ecothreads-lagos',
    description: 'Store slug: one vendor’s products.',
  })
  @IsOptional()
  @Matches(/^[a-z0-9-]{1,80}$/)
  vendor?: string;

  @ApiPropertyOptional({ example: 500, description: 'US cents, inclusive.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minPriceCents?: number;

  @ApiPropertyOptional({ example: 2000, description: 'US cents, inclusive.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxPriceCents?: number;

  @ApiPropertyOptional({
    type: Boolean,
    description: '`true`: Certified only; `false`: Fysi Reviewed only.',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  certified?: boolean;

  @ApiPropertyOptional({ type: Boolean, description: '`true` hides sold-out items.' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  inStock?: boolean;

  @ApiPropertyOptional({
    enum: SORTS,
    description:
      'Default: `relevance` with `q`, else `newest` (the "New in" view).',
  })
  @IsOptional()
  @IsIn(SORTS)
  sort?: (typeof SORTS)[number];
}

export class ProductVendorDto {
  @ApiProperty({ example: 'ecothreads-lagos' }) slug: string;
  @ApiProperty({ example: 'EcoThreads Lagos' }) businessName: string;

  @ApiProperty({
    example: true,
    description: 'Always true on the storefront: only verified vendors sell (verified badge).',
  })
  verified: true;

  @ApiProperty({ enum: BADGES }) badge: Badge;
}

export class ProductVendorDetailDto extends ProductVendorDto {
  @ApiProperty({ nullable: true }) logoUrl: string | null;
  @ApiProperty({ nullable: true, example: 'Lekki' }) city: string | null;
  @ApiProperty({ nullable: true, example: 'Lagos' }) state: string | null;
}

export class ProductSummaryDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'organic-cotton-tote-bag-k3x9qa' }) slug: string;
  @ApiProperty({ example: 'Organic cotton tote bag' }) title: string;

  @ApiProperty({ type: PriceDto, description: 'What the customer pays now, after any vendor promotion.' })
  price: PriceDto;

  @ApiProperty({
    type: PriceDto,
    nullable: true,
    description: 'The price before the promotion (strike it through); null when not on sale.',
  })
  originalPrice: PriceDto | null;

  @ApiProperty({ nullable: true, example: 15, description: 'Percent off while on sale.' })
  discountPercent: number | null;

  @ApiProperty() inStock: boolean;

  @ApiProperty({ nullable: true, description: 'Cover image link (expires).' })
  imageUrl: string | null;

  @ApiProperty({
    enum: BADGES,
    description: '`certified` (a recognised label) or `fysi_reviewed`.',
  })
  badge: Badge;

  @ApiProperty({ type: [CertificationDto] }) certifications: CertificationDto[];
  @ApiProperty({ type: CategoryRefDto }) category: CategoryRefDto;
  @ApiProperty({ type: ProductVendorDto }) vendor: ProductVendorDto;
  @ApiProperty() createdAt: Date;
}

export class ProductDetailDto extends ProductSummaryDto {
  @ApiProperty() description: string;

  @ApiProperty({ example: 40, description: 'Units available.' })
  stock: number;

  @ApiProperty({ type: [ProductImageDto] }) images: ProductImageDto[];

  @ApiProperty({
    example: { average: 4.6, count: 23 },
    description: 'Verified-purchase reviews; `average` is null without any.',
  })
  rating: { average: number | null; count: number };

  @ApiProperty({ type: ProductVendorDetailDto })
  declare vendor: ProductVendorDetailDto;
}

/* ---------------- admin ---------------- */

export class AdminProductsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Matches the title or the store name.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'One vendor’s products.' })
  @IsOptional()
  @IsUUID()
  vendorId?: string;

  @ApiPropertyOptional({ enum: moderationStatusEnum.enumValues })
  @IsOptional()
  @IsIn(moderationStatusEnum.enumValues)
  moderationStatus?: ModerationStatus;

  @ApiPropertyOptional({
    type: Boolean,
    description: 'Include products vendors deleted.',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  includeDeleted?: boolean;
}

export class AdminProductDto extends VendorProductDto {
  @ApiProperty({ format: 'uuid' }) vendorId: string;
  @ApiProperty({ nullable: true }) vendorName: string | null;
  @ApiProperty({ nullable: true }) vendorSlug: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  deletedAt: Date | null;
}

export class ModerationReasonDto {
  @ApiProperty({
    example: 'The listing claims FSC certification the store does not hold.',
    minLength: 3,
    maxLength: 1000,
    description: 'Shown to the vendor and kept in the audit log.',
  })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason: string;
}

export class AdminCreateProductDto extends CreateProductDto {
  @ApiProperty({ format: 'uuid', description: 'The verified store to list it under (its user id).' })
  @IsUUID()
  vendorId: string;
}
