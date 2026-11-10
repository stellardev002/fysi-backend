import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDate,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { trim } from '../../auth/dto/auth.dto.js';
import { PaginationQueryDto } from '../../common/pagination.js';
import { PriceDto } from '../../products/dto/products.dto.js';

export const MAX_PROMOTION_PRODUCTS = 200;
export const MAX_PROMOTION_DAYS = 180;
export const PROMOTION_STATES = ['scheduled', 'running', 'paused', 'expired', 'ended'] as const;
export type PromotionState = (typeof PROMOTION_STATES)[number];

export class CreatePromotionDto {
  @ApiProperty({ example: 'Black Friday', minLength: 2, maxLength: 80 })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name: string;

  @ApiProperty({ example: 15, minimum: 1, maximum: 90, description: 'Whole percent off.' })
  @IsInt()
  @Min(1)
  @Max(90)
  discountPercent: number;

  @ApiProperty({ example: '2026-11-27T00:00:00.000Z', description: 'When prices drop (ISO 8601).' })
  @Type(() => Date)
  @IsDate()
  startsAt: Date;

  @ApiProperty({ example: '2026-11-30T23:59:59.000Z', description: 'When prices go back.' })
  @Type(() => Date)
  @IsDate()
  endsAt: Date;

  @ApiPropertyOptional({ default: false, description: 'Every product of the store, including ones added later.' })
  @IsOptional()
  @IsBoolean()
  appliesToAll?: boolean;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    maxItems: MAX_PROMOTION_PRODUCTS,
    description: 'Your products on sale. Required unless `appliesToAll`.',
  })
  @ValidateIf((o: CreatePromotionDto) => !o.appliesToAll || o.productIds !== undefined)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PROMOTION_PRODUCTS)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  productIds?: string[];
}

export class UpdatePromotionDto extends PartialType(CreatePromotionDto) {}

export class PromotionsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: PROMOTION_STATES })
  @IsOptional()
  @IsIn(PROMOTION_STATES)
  state?: PromotionState;
}

export class PromotionProductDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() title: string;
  @ApiProperty() slug: string;
  @ApiProperty({ type: PriceDto }) price: PriceDto;
  @ApiProperty({ type: PriceDto, description: 'Price with this promotion.' }) salePrice: PriceDto;
}

export class PromotionStatsDto {
  @ApiProperty({ example: 14, description: 'Paid orders with at least one item at this price.' }) orders: number;
  @ApiProperty({ example: 21 }) unitsSold: number;
  @ApiProperty({ type: PriceDto, description: 'Sales at the promotional price.' }) revenue: PriceDto;
  @ApiProperty({ type: PriceDto, description: 'Discount customers received.' }) discountGiven: PriceDto;
}

export class PromotionDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Black Friday' }) name: string;
  @ApiProperty({ example: 15 }) discountPercent: number;
  @ApiProperty() appliesToAll: boolean;
  @ApiProperty({ type: [PromotionProductDto], description: 'Empty when `appliesToAll`.' })
  products: PromotionProductDto[];
  @ApiProperty() startsAt: Date;
  @ApiProperty() endsAt: Date;

  @ApiProperty({
    enum: PROMOTION_STATES,
    description:
      '`scheduled`: starts later. `running`: prices are lowered now. `paused`: switched off. `expired`: end date passed. `ended`: stopped for good.',
  })
  state: PromotionState;

  @ApiProperty({ type: PromotionStatsDto }) stats: PromotionStatsDto;
  @ApiProperty() createdAt: Date;
}
