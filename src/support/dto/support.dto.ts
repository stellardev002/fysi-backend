import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { normaliseEmail, trim } from '../../auth/dto/auth.dto.js';
import { PaginationQueryDto } from '../../common/pagination.js';
import {
  ticketCategoryEnum,
  type TicketCategory,
  ticketPriorityEnum,
  type TicketPriority,
  ticketStatusEnum,
  type TicketStatus,
} from '../../database/schema/index.js';

export class CreateTicketDto {
  @ApiProperty({ enum: ticketCategoryEnum.enumValues, example: 'delivery' })
  @IsIn(ticketCategoryEnum.enumValues)
  category: TicketCategory;

  @ApiProperty({ example: 'My parcel has not arrived', minLength: 3, maxLength: 150 })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(150)
  subject: string;

  @ApiProperty({
    example: 'The vendor marked it shipped 9 days ago and the tracking number does not work.',
    minLength: 10,
    maxLength: 5000,
  })
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(5000)
  message: string;

  @ApiPropertyOptional({
    example: 'FYK3M9QXWA',
    description: 'Order this is about. Linked when it is yours (customer) or contains your items (vendor).',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @Matches(/^FY[A-Z2-9]{10}$/, { message: 'orderNumber looks like FYK3M9QXWA' })
  orderNumber?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Product this is about (e.g. reporting a listing).' })
  @IsOptional()
  @IsUUID()
  productId?: string;

  @ApiPropertyOptional({ example: 'Grace Ajayi', description: 'Required without a sign-in.' })
  @ValidateIf((o: CreateTicketDto) => o.email !== undefined || o.name !== undefined)
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ example: 'grace@example.com', description: 'Required without a sign-in; replies go here.' })
  @ValidateIf((o: CreateTicketDto) => o.email !== undefined || o.name !== undefined)
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(254)
  email?: string;
}

export class TicketReplyDto {
  @ApiProperty({ example: 'Thanks — here is a photo of the label.', minLength: 1, maxLength: 5000 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  body: string;
}

export class StaffReplyDto extends TicketReplyDto {
  @ApiPropertyOptional({
    enum: ['open', 'pending', 'resolved'],
    default: 'pending',
    description: 'Status after the reply. `pending`: waiting for the requester.',
  })
  @IsOptional()
  @IsIn(['open', 'pending', 'resolved'])
  status?: 'open' | 'pending' | 'resolved';
}

export class UpdateTicketDto {
  @ApiPropertyOptional({ enum: ticketStatusEnum.enumValues })
  @IsOptional()
  @IsIn(ticketStatusEnum.enumValues)
  status?: TicketStatus;

  @ApiPropertyOptional({ enum: ticketPriorityEnum.enumValues })
  @IsOptional()
  @IsIn(ticketPriorityEnum.enumValues)
  priority?: TicketPriority;

  @ApiPropertyOptional({ format: 'uuid', nullable: true, description: 'An admin; null to unassign.' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  assignedTo?: string | null;
}

export class MyTicketsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ticketStatusEnum.enumValues })
  @IsOptional()
  @IsIn(ticketStatusEnum.enumValues)
  status?: TicketStatus;
}

export class AdminTicketsQueryDto extends MyTicketsQueryDto {
  @ApiPropertyOptional({ enum: ticketCategoryEnum.enumValues })
  @IsOptional()
  @IsIn(ticketCategoryEnum.enumValues)
  category?: TicketCategory;

  @ApiPropertyOptional({ enum: ticketPriorityEnum.enumValues })
  @IsOptional()
  @IsIn(ticketPriorityEnum.enumValues)
  priority?: TicketPriority;

  @ApiPropertyOptional({ description: '`me`, `none`, or an admin id.' })
  @IsOptional()
  @ValidateIf((_, v) => v !== 'me' && v !== 'none')
  @IsUUID()
  assignedTo?: string;

  @ApiPropertyOptional({ description: 'Ticket number, order number, email or subject.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}

export class TicketMessageDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ enum: ['requester', 'staff'] }) authorType: string;
  @ApiProperty({ example: 'Fysi Support' }) authorName: string;
  @ApiProperty() body: string;
  @ApiProperty() createdAt: Date;
}

export class TicketSummaryDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'TK7K3M9QXW' }) number: string;
  @ApiProperty({ enum: ticketCategoryEnum.enumValues }) category: TicketCategory;
  @ApiProperty() subject: string;
  @ApiProperty({ enum: ticketStatusEnum.enumValues }) status: TicketStatus;
  @ApiProperty({ enum: ticketPriorityEnum.enumValues }) priority: TicketPriority;
  @ApiProperty({ nullable: true, example: 'FYK3M9QXWA' }) orderNumber: string | null;
  @ApiProperty({ nullable: true, format: 'uuid' }) vendorOrderId: string | null;
  @ApiProperty({ nullable: true, format: 'uuid' }) productId: string | null;
  @ApiProperty() lastMessageAt: Date;
  @ApiProperty() createdAt: Date;
}

export class TicketDetailDto extends TicketSummaryDto {
  @ApiProperty({ type: [TicketMessageDto] }) messages: TicketMessageDto[];
  @ApiProperty({ description: 'The requester can still reply (not closed).' }) canReply: boolean;
}

export class AdminTicketSummaryDto extends TicketSummaryDto {
  @ApiProperty() name: string;
  @ApiProperty() email: string;
  @ApiProperty({ nullable: true, format: 'uuid', description: 'Null for a guest.' }) userId: string | null;
  @ApiProperty({ nullable: true, example: 'customer' }) userRole: string | null;
  @ApiProperty({ nullable: true, format: 'uuid' }) assignedTo: string | null;
  @ApiProperty({ nullable: true }) assignedToName: string | null;
  @ApiProperty({ example: 3 }) messageCount: number;
}

export class AdminTicketDetailDto extends AdminTicketSummaryDto {
  @ApiProperty({ type: [TicketMessageDto] }) messages: TicketMessageDto[];
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) resolvedAt: Date | null;
}
