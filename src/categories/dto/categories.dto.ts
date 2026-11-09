import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { trim } from '../../auth/dto/auth.dto.js';

export class CategoryDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Clothing' })
  name: string;

  @ApiProperty({ example: 'clothing' })
  slug: string;
}

export class PublicCategoryDto extends CategoryDto {
  @ApiProperty({
    example: 42,
    description: 'Products customers can see in this category right now.',
  })
  productCount: number;
}

export class AdminCategoryDto extends CategoryDto {
  @ApiProperty({
    example: true,
    description: 'Inactive categories are hidden from vendors and filters.',
  })
  isActive: boolean;

  @ApiProperty({ example: 20, description: 'Lower sorts first.' })
  sortOrder: number;

  @ApiProperty({
    example: 57,
    description: 'Products filed under it, any status except deleted.',
  })
  productCount: number;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class CreateCategoryDto {
  @ApiProperty({ example: 'Kitchen', minLength: 2, maxLength: 60 })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name: string;

  @ApiPropertyOptional({
    example: 'kitchen',
    description:
      'Lowercase words joined by hyphens. Defaults to one made from the name.',
  })
  @IsOptional()
  @Matches(SLUG, { message: 'slug must be lowercase words joined by hyphens' })
  @MaxLength(60)
  slug?: string;

  @ApiPropertyOptional({ example: 80, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  sortOrder?: number;
}

export class UpdateCategoryDto {
  @ApiPropertyOptional({
    example: 'Kitchen & Dining',
    minLength: 2,
    maxLength: 60,
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name?: string;

  @ApiPropertyOptional({
    example: false,
    description:
      'Deactivate instead of deleting: existing products keep the category.',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ example: 80 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  sortOrder?: number;
}
