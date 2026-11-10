import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import { trimOrNull } from '../../auth/dto/auth.dto.js';
import { AddressDto } from '../../orders/dto/orders.dto.js';
import { ProductSummaryDto } from '../../products/dto/products.dto.js';

export const MAX_WISHLIST = 200;
export const MAX_ADDRESSES = 10;

export class WishlistItemDto {
  @ApiProperty({ format: 'uuid' }) productId: string;

  @ApiProperty({
    type: ProductSummaryDto,
    nullable: true,
    description: 'Null when the product is no longer on sale (keep showing it as unavailable, or remove it).',
  })
  product: ProductSummaryDto | null;

  @ApiProperty() addedAt: Date;
}

export class WishlistStatusDto {
  @ApiProperty({ format: 'uuid' }) productId: string;
  @ApiProperty({ description: 'Whether it is in the wishlist now.' }) saved: boolean;
  @ApiProperty({ example: 12 }) count: number;
}

export class SaveAddressDto extends AddressDto {
  @ApiPropertyOptional({ example: 'Home', maxLength: 40, nullable: true })
  @IsOptional()
  @Transform(trimOrNull)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(40)
  label?: string | null;

  @ApiPropertyOptional({
    default: false,
    description: 'Use it by default at checkout. The first address is always the default.',
  })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class UpdateAddressDto extends PartialType(SaveAddressDto) {}

export class SavedAddressDto extends AddressDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ nullable: true, example: 'Home' }) label: string | null;
  @ApiProperty() isDefault: boolean;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
  declare line2: string | null;
  declare notes: string | null;
}
