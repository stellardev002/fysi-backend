import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
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
import { trim, trimOrNull } from '../../auth/dto/auth.dto.js';
import { PaginationQueryDto } from '../../common/pagination.js';
import { reviewStatusEnum, type ReviewStatus } from '../../database/schema/index.js';

export class CreateReviewDto {
  @ApiProperty({ format: 'uuid', description: 'From `GET /reviews/pending`.' })
  @IsUUID()
  orderLineId: string;

  @ApiProperty({ example: 5, minimum: 1, maximum: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  @ApiPropertyOptional({ example: 'Sturdy and beautiful', maxLength: 100, nullable: true })
  @IsOptional()
  @Transform(trimOrNull)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(100)
  title?: string | null;

  @ApiProperty({ example: 'Carries all my groceries and still looks new after a month.', minLength: 10, maxLength: 2000 })
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  body: string;
}

export class UpdateReviewDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 5 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number;

  @ApiPropertyOptional({ maxLength: 100, nullable: true })
  @IsOptional()
  @Transform(trimOrNull)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(100)
  title?: string | null;

  @ApiPropertyOptional({ minLength: 10, maxLength: 2000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  body?: string;
}

export const REVIEW_SORTS = ['newest', 'highest', 'lowest'] as const;

export class ProductReviewsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 5, description: 'Only this many stars.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number;

  @ApiPropertyOptional({ enum: REVIEW_SORTS, default: 'newest' })
  @IsOptional()
  @IsIn(REVIEW_SORTS)
  sort: (typeof REVIEW_SORTS)[number] = 'newest';
}

export class VendorReviewsQueryDto extends ProductReviewsQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  productId?: string;
}

export class AdminReviewsQueryDto extends VendorReviewsQueryDto {
  @ApiPropertyOptional({ enum: reviewStatusEnum.enumValues })
  @IsOptional()
  @IsIn(reviewStatusEnum.enumValues)
  status?: ReviewStatus;
}

export class RatingSummaryDto {
  @ApiProperty({ example: 4.6, nullable: true, description: 'One decimal; null without reviews.' })
  average: number | null;

  @ApiProperty({ example: 23 }) count: number;

  @ApiProperty({
    example: { '1': 0, '2': 1, '3': 1, '4': 5, '5': 16 },
    description: 'Reviews per star rating.',
  })
  distribution: Record<'1' | '2' | '3' | '4' | '5', number>;
}

export class ReviewProductDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() title: string;
  @ApiProperty() slug: string;
}

export class ReviewDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 5 }) rating: number;
  @ApiProperty({ nullable: true }) title: string | null;
  @ApiProperty() body: string;
  @ApiProperty({ example: 'Grace A.', description: 'First name and initial.' }) author: string;
  @ApiProperty({ example: true, description: 'Always true: only buyers can review.' }) verifiedPurchase: true;
  @ApiProperty({ type: ReviewProductDto }) product: ReviewProductDto;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}

export class MyReviewDto extends ReviewDto {
  @ApiProperty({ enum: reviewStatusEnum.enumValues }) status: ReviewStatus;
  @ApiProperty({ nullable: true, description: 'Why an admin hid it.' }) moderationReason: string | null;
  @ApiProperty({ format: 'uuid' }) orderLineId: string;
}

export class AdminReviewDto extends MyReviewDto {
  @ApiProperty({ format: 'uuid' }) customerId: string;
  @ApiProperty() customerEmail: string;
  @ApiProperty({ nullable: true }) vendorName: string | null;
}

export class PendingReviewDto {
  @ApiProperty({ format: 'uuid' }) orderLineId: string;
  @ApiProperty({ example: 'FYK3M9QXWA' }) orderNumber: string;
  @ApiProperty({ type: ReviewProductDto }) product: ReviewProductDto;
  @ApiProperty({ nullable: true }) imageUrl: string | null;
  @ApiProperty({ nullable: true }) vendorName: string | null;
  @ApiProperty({ example: 2 }) quantity: number;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) deliveredAt: Date | null;
}

export class HideReviewDto {
  @ApiProperty({ example: 'Contains a phone number', minLength: 3, maxLength: 500 })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}
