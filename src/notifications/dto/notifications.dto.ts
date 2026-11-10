import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { trim } from '../../auth/dto/auth.dto.js';
import { PaginationQueryDto } from '../../common/pagination.js';

export const queryBoolean = ({ value }: { value: unknown }) =>
  value === 'true' || value === true ? true : value === 'false' || value === false ? false : value;

export class InboxQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ type: Boolean, description: '`true`: unread only.' })
  @IsOptional()
  @Transform(queryBoolean)
  @IsBoolean()
  unread?: boolean;
}

export class NotificationDto {
  @ApiProperty({ format: 'uuid' }) id: string;

  @ApiProperty({
    example: 'order.shipped',
    description:
      'What happened: `order.paid`, `order.new`, `order.shipped`, `order.cancelled`, `order.problem`, `vendor.decision`, `review.new`, `ticket.new`, `ticket.reply`, `vendor.submitted`, `announcement`.',
  })
  kind: string;

  @ApiProperty({ example: 'EcoThreads Lagos shipped your items' }) title: string;
  @ApiProperty({ example: 'Order FYK3M9QXWA · GIG Logistics GIG-4471' }) body: string;

  @ApiProperty({
    nullable: true,
    example: '/account/orders/0197c2b0-…',
    description: 'Frontend path to open when tapped.',
  })
  link: string | null;

  @ApiProperty({ type: Object, example: { orderId: '0197c2b0-…' } })
  data: Record<string, unknown>;

  @ApiProperty() read: boolean;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) readAt: Date | null;
  @ApiProperty() createdAt: Date;
}

export class UnreadCountDto {
  @ApiProperty({ example: 3 }) unread: number;
}

export class ReadAllResultDto {
  @ApiProperty({ example: 3, description: 'Notifications marked read.' }) updated: number;
}

export const BROADCAST_AUDIENCES = ['all', 'customers', 'vendors', 'staff', 'users'] as const;
export type BroadcastAudience = (typeof BROADCAST_AUDIENCES)[number];

export class BroadcastDto {
  @ApiProperty({
    enum: BROADCAST_AUDIENCES,
    description:
      '`all`: every customer and vendor. `staff`: admins. `users`: only the accounts in `userIds`. Deleted and suspended accounts are skipped.',
  })
  @IsIn(BROADCAST_AUDIENCES)
  audience: BroadcastAudience;

  @ApiPropertyOptional({ type: [String], format: 'uuid', maxItems: 500 })
  @ValidateIf((o: BroadcastDto) => o.audience === 'users')
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  userIds?: string[];

  @ApiProperty({ example: 'Black Friday week starts Monday', maxLength: 120 })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  title: string;

  @ApiProperty({ example: 'Vendors: set up your promotions before Sunday.', maxLength: 1000 })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  body: string;

  @ApiPropertyOptional({ example: '/vendor/promotions', nullable: true, description: 'Frontend path (starts with /).' })
  @IsOptional()
  @Matches(/^\/[^\s]{0,300}$/, { message: 'link must be a path on the site, starting with /' })
  link?: string;
}

export class BroadcastSummaryDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ enum: BROADCAST_AUDIENCES }) audience: string;
  @ApiProperty() title: string;
  @ApiProperty() body: string;
  @ApiProperty({ nullable: true }) link: string | null;
  @ApiProperty({ example: 1240 }) recipientCount: number;
  @ApiProperty({ example: 312, description: 'Recipients who opened it in their inbox.' }) readCount: number;
  @ApiProperty({ format: 'uuid' }) sentBy: string;
  @ApiProperty({ nullable: true }) sentByName: string | null;
  @ApiProperty() createdAt: Date;
}
