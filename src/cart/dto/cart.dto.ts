import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  PriceDto,
  ProductSummaryDto,
} from '../../products/dto/products.dto.js';

export const MAX_QUANTITY = 99;
export const MAX_CART_LINES = 50;

export class CartQuantityDto {
  @ApiProperty({ example: 2, minimum: 1, maximum: MAX_QUANTITY })
  @IsInt()
  @Min(1)
  @Max(MAX_QUANTITY)
  quantity: number;
}

export class GuestCartItemDto extends CartQuantityDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  productId: string;
}

export class GuestCartDto {
  @ApiProperty({
    type: [GuestCartItemDto],
    maxItems: MAX_CART_LINES,
    description: 'The cart kept in the browser (localStorage).',
  })
  @IsArray()
  @ArrayMaxSize(MAX_CART_LINES)
  @ValidateNested({ each: true })
  @Type(() => GuestCartItemDto)
  items: GuestCartItemDto[];
}

export const LINE_ISSUES = ['unavailable', 'out_of_stock', 'insufficient_stock'] as const;
export type LineIssue = (typeof LINE_ISSUES)[number];

export class CartLineDto {
  @ApiProperty({ format: 'uuid' }) productId: string;

  @ApiProperty({ example: 2 }) quantity: number;

  @ApiProperty({
    type: ProductSummaryDto,
    nullable: true,
    description: 'Null when the product is no longer on sale.',
  })
  product: ProductSummaryDto | null;

  @ApiProperty({
    type: PriceDto,
    nullable: true,
    description: 'Unit price × quantity. Null when unavailable.',
  })
  lineTotal: PriceDto | null;

  @ApiProperty({
    example: 40,
    description: 'Most this line can hold right now (stock, up to 99).',
  })
  maxQuantity: number;

  @ApiPropertyOptional({
    enum: LINE_ISSUES,
    nullable: true,
    description:
      '`unavailable`: no longer sold (remove it). `out_of_stock`: sold out. `insufficient_stock`: lower the quantity to `maxQuantity`. Lines with an issue are left out of the subtotal and block checkout.',
  })
  issue: LineIssue | null;
}

export class CartDto {
  @ApiProperty({ type: [CartLineDto] }) items: CartLineDto[];

  @ApiProperty({
    type: PriceDto,
    description: 'Sum of lines without issues.',
  })
  subtotal: PriceDto;

  @ApiProperty({ example: 3, description: 'Units across lines without issues.' })
  itemCount: number;

  @ApiProperty({
    example: 2,
    description:
      'Distinct stores in the cart; one checkout pays them all (multi-vendor cart).',
  })
  vendorCount: number;

  @ApiProperty({ description: 'No line has an issue and the cart is not empty.' })
  readyForCheckout: boolean;
}

export class SkippedItemDto {
  @ApiProperty({ format: 'uuid' }) productId: string;
  @ApiProperty({ enum: ['unavailable', 'out_of_stock'] })
  reason: 'unavailable' | 'out_of_stock';
}

export class MergeResultDto extends CartDto {
  @ApiProperty({
    type: [SkippedItemDto],
    description: 'Guest items not added; tell the customer, then clear the browser cart.',
  })
  skipped: SkippedItemDto[];
}
