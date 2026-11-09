import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { trim } from '../../auth/dto/auth.dto.js';
import { PaginationQueryDto } from '../../common/pagination.js';
import {
  escrowStatusEnum,
  paymentStatusEnum,
  type PaymentStatus,
  transferStatusEnum,
  type TransferStatus,
} from '../../database/schema/index.js';
import { PriceDto } from '../../products/dto/products.dto.js';

const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

export class AdminPaymentsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: paymentStatusEnum.enumValues })
  @IsOptional()
  @IsIn(paymentStatusEnum.enumValues)
  status?: PaymentStatus;

  @ApiPropertyOptional({ type: Boolean, description: '`true`: only payments with money to send back (PRD A4: flagged).' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  needsRefund?: boolean;

  @ApiPropertyOptional({ description: 'Transaction hash, payer address or memo.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}

export class AdminPaymentDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ enum: paymentStatusEnum.enumValues }) status: PaymentStatus;
  @ApiProperty({ nullable: true, example: 'FYK3M9QXWA' }) orderNumber: string | null;
  @ApiProperty({ description: 'Paying address.' }) payer: string;
  @ApiProperty({ example: '25.5' }) amount: string;
  @ApiProperty({ example: 'USDC' }) assetCode: string;
  @ApiProperty({ nullable: true }) memo: string | null;
  @ApiProperty({ example: '0', description: 'Still to send back.' }) refundable: string;
  @ApiProperty({ nullable: true, description: 'Why it was flagged.' }) note: string | null;
  @ApiProperty() txHash: string;
  @ApiProperty() explorerUrl: string;
  @ApiProperty() at: Date;
}

export class ReasonDto {
  @ApiProperty({ example: 'Paid twice by mistake', minLength: 3, maxLength: 500 })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}

export const TRANSFER_KINDS = ['payout', 'refund', 'withdrawal'] as const;

export class AdminTransfersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: transferStatusEnum.enumValues })
  @IsOptional()
  @IsIn(transferStatusEnum.enumValues)
  status?: TransferStatus;
}

export class AdminTransferDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ enum: TRANSFER_KINDS }) kind: (typeof TRANSFER_KINDS)[number];
  @ApiProperty() destination: string;
  @ApiProperty({ example: '23.75' }) amount: string;
  @ApiProperty({ enum: transferStatusEnum.enumValues }) status: TransferStatus;
  @ApiProperty() attempts: number;
  @ApiProperty({ nullable: true }) lastError: string | null;
  @ApiProperty({ nullable: true }) txHash: string | null;
  @ApiProperty({ nullable: true }) explorerUrl: string | null;
  @ApiProperty() createdAt: Date;
}

export class AdminVendorOrdersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: escrowStatusEnum.enumValues, description: '`disputed`: the problem-report queue.' })
  @IsOptional()
  @IsIn(escrowStatusEnum.enumValues)
  escrowStatus?: string;
}

export class AdminVendorOrderDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() orderNumber: string;
  @ApiProperty({ nullable: true }) vendorName: string | null;
  @ApiProperty() customerEmail: string;
  @ApiProperty() status: string;
  @ApiProperty({ enum: escrowStatusEnum.enumValues }) escrowStatus: string;
  @ApiProperty({ type: PriceDto }) subtotal: PriceDto;
  @ApiProperty({ type: PriceDto }) payout: PriceDto;
  @ApiProperty({ nullable: true }) problemReason: string | null;
  @ApiProperty({ nullable: true }) trackingNumber: string | null;
  @ApiProperty() updatedAt: Date;
}

export class DashboardQueryDto {
  @ApiPropertyOptional({ enum: ['day', 'week'], default: 'day' })
  @IsOptional()
  @IsIn(['day', 'week'])
  period: 'day' | 'week' = 'day';

  @ApiPropertyOptional({ default: 30, minimum: 1, maximum: 366 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(366)
  days = 30;
}

export class DashboardPointDto {
  @ApiProperty({ example: '2026-11-09', description: 'Start of the day or ISO week (UTC).' })
  period: string;
  @ApiProperty() newVendors: number;
  @ApiProperty() newCustomers: number;
  @ApiProperty() paidOrders: number;
  @ApiProperty({ type: PriceDto, description: 'Payment volume (USD = USDC).' }) volume: PriceDto;
  @ApiProperty({ description: 'Payments that could not be matched to an order.' }) failedPayments: number;
}

export class DashboardDto {
  @ApiProperty({ type: [DashboardPointDto] }) series: DashboardPointDto[];

  @ApiProperty({
    example: { vendorsPending: 3, paymentsToRefund: 1, disputes: 0, transfersFailed: 0 },
    description: 'Queues that need an admin now.',
  })
  queues: { vendorsPending: number; paymentsToRefund: number; disputes: number; transfersFailed: number };
}
