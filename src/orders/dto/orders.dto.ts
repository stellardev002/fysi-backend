import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  normalisePhone,
  PHONE,
  trim,
  trimOrNull,
} from '../../auth/dto/auth.dto.js';
import { PaginationQueryDto } from '../../common/pagination.js';
import {
  escrowStatusEnum,
  type EscrowStatus,
  fulfilmentStatusEnum,
  type FulfilmentStatus,
  orderStatusEnum,
  type OrderStatus,
} from '../../database/schema/index.js';
import { PriceDto } from '../../products/dto/products.dto.js';
import { NIGERIAN_STATES } from '../../vendors/dto/vendors.dto.js';

export class AddressDto {
  @ApiProperty({ example: 'Grace Ajayi', maxLength: 100 })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  recipientName: string;

  @ApiProperty({ example: '+2348031234567' })
  @Transform(normalisePhone)
  @Matches(PHONE, { message: 'phone must be in international format, e.g. +2348031234567' })
  phone: string;

  @ApiProperty({ example: '14 Bourdillon Road', maxLength: 200 })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  line1: string;

  @ApiPropertyOptional({ example: 'Flat 3', maxLength: 200, nullable: true })
  @IsOptional()
  @Transform(trimOrNull)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(200)
  line2?: string | null;

  @ApiProperty({ example: 'Ikoyi', maxLength: 80 })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  city: string;

  @ApiProperty({ enum: NIGERIAN_STATES, example: 'Lagos' })
  @IsIn(NIGERIAN_STATES)
  state: string;

  @ApiPropertyOptional({ example: 'Call on arrival', maxLength: 300, nullable: true })
  @IsOptional()
  @Transform(trimOrNull)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(300)
  notes?: string | null;
}

export class CheckoutDto {
  @ApiProperty({ type: AddressDto, description: 'Delivery address (PRD C5).' })
  @ValidateNested()
  @Type(() => AddressDto)
  deliveryAddress: AddressDto;
}

export class PaymentInstructionsDto {
  @ApiProperty({ example: 'testnet' }) network: string;
  @ApiProperty({ example: 'Test SDF Network ; September 2015' }) networkPassphrase: string;

  @ApiProperty({ description: 'Fysi settlement account: the payment destination.' })
  destination: string;

  @ApiProperty({ example: 'USDC' }) assetCode: string;
  @ApiProperty() assetIssuer: string;

  @ApiProperty({
    example: 'FYK3M9QXWA',
    description: 'Text memo. Required: it is how the payment is matched to the order.',
  })
  memo: string;

  @ApiProperty({ example: '25.5', description: 'USDC still to pay (7 decimals at most).' })
  amountDue: string;

  @ApiProperty({
    example:
      'web+stellar:pay?destination=G…&amount=25.5&asset_code=USDC&asset_issuer=G…&memo=FYK3M9QXWA&memo_type=MEMO_TEXT',
    description: 'SEP-7 payment request: render as the checkout QR code (PRD: scan QR).',
  })
  sep7Uri: string;

  @ApiProperty({
    example: 'https://fysi.ng/pay/Hk3…',
    description: 'Hosted pay page to open later or send to someone else (PRD: payment link).',
  })
  payLink: string;

  @ApiProperty({ description: 'The QR code and link stop working at this time.' })
  expiresAt: Date;
}

export class OrderLineDto {
  @ApiProperty({ format: 'uuid' }) productId: string;
  @ApiProperty({ example: 'Organic cotton tote bag' }) title: string;
  @ApiProperty({ type: PriceDto }) unitPrice: PriceDto;
  @ApiProperty({ example: 2 }) quantity: number;
  @ApiProperty({ type: PriceDto }) lineTotal: PriceDto;
}

export class TransactionRefDto {
  @ApiProperty() txHash: string;
  @ApiProperty({ example: 'https://stellar.expert/explorer/testnet/tx/…' }) explorerUrl: string;
  @ApiProperty({ example: '25.5' }) amount: string;
  @ApiProperty() at: Date;
}

export class CustomerVendorOrderDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'EcoThreads Lagos' }) vendorName: string;
  @ApiProperty({ nullable: true }) vendorSlug: string | null;
  @ApiProperty({ enum: fulfilmentStatusEnum.enumValues }) status: FulfilmentStatus;
  @ApiProperty({ type: PriceDto }) subtotal: PriceDto;
  @ApiProperty({ type: [OrderLineDto] }) lines: OrderLineDto[];
  @ApiProperty({ nullable: true }) carrier: string | null;
  @ApiProperty({ nullable: true }) trackingNumber: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) shippedAt: Date | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) deliveredAt: Date | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) confirmedAt: Date | null;

  @ApiProperty({ description: 'Show "Confirm delivery" (PRD C8).' })
  canConfirmDelivery: boolean;

  @ApiProperty({ description: 'Show "Report a problem" (until 7 days after delivery).' })
  canReportProblem: boolean;

  @ApiProperty({ nullable: true }) problemReason: string | null;
}

export class OrderDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'FYK3M9QXWA' }) number: string;
  @ApiProperty({ enum: orderStatusEnum.enumValues }) status: OrderStatus;
  @ApiProperty({ type: PriceDto }) total: PriceDto;

  @ApiProperty({ example: '10', description: 'USDC received so far.' })
  paid: string;

  @ApiProperty({ type: AddressDto }) deliveryAddress: AddressDto;

  @ApiProperty({
    type: PaymentInstructionsDto,
    nullable: true,
    description: 'While awaiting payment: everything to pay, by any method. Null otherwise.',
  })
  payment: PaymentInstructionsDto | null;

  @ApiProperty({
    type: [TransactionRefDto],
    description: 'Payments received, with transaction hashes and explorer links (PRD C7).',
  })
  transactions: TransactionRefDto[];

  @ApiProperty({ type: [CustomerVendorOrderDto] }) vendorOrders: CustomerVendorOrderDto[];
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) paidAt: Date | null;
  @ApiProperty() createdAt: Date;
}

export class ExternalPrepareDto {
  @ApiProperty({
    description: 'Address of the customer’s own wallet (Freighter, LOBSTR, xBull, Albedo…).',
  })
  @Matches(/^G[A-Z2-7]{55}$/, { message: 'sourceAddress must be a Stellar G… address' })
  sourceAddress: string;
}

export class PreparedPaymentDto {
  @ApiProperty({ description: 'Unsigned transaction (base64 XDR) for the wallet to sign.' })
  transaction: string;

  @ApiProperty() networkPassphrase: string;
  @ApiProperty({ example: '25.5' }) amount: string;
  @ApiProperty() expiresAt: Date;
}

export class ExternalSubmitDto {
  @ApiProperty({ description: 'The transaction from `prepare`, signed by the wallet (base64 XDR).' })
  @IsString()
  @MinLength(100)
  @MaxLength(20_000)
  signedTransaction: string;
}

export class WalletPayDto {
  @ApiProperty({ example: '482913', description: '6-digit Fysi wallet PIN.' })
  @Matches(/^\d{6}$/, { message: 'pin must be 6 digits' })
  pin: string;
}

export class ProblemDto {
  @ApiProperty({
    example: 'The tote arrived torn at the handle.',
    minLength: 5,
    maxLength: 1000,
  })
  @Transform(trim)
  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  reason: string;
}

export class PayPageDto {
  @ApiProperty({ example: 'FYK3M9QXWA' }) number: string;
  @ApiProperty({ enum: orderStatusEnum.enumValues }) status: OrderStatus;
  @ApiProperty({ type: PriceDto }) total: PriceDto;
  @ApiProperty({ example: '0' }) paid: string;

  @ApiProperty({ type: [String], example: ['Organic cotton tote bag × 2'] })
  items: string[];

  @ApiProperty({ type: PaymentInstructionsDto, nullable: true })
  payment: PaymentInstructionsDto | null;
}

/* ---------- vendor ---------- */

export class VendorOrdersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: fulfilmentStatusEnum.enumValues })
  @IsOptional()
  @IsIn(fulfilmentStatusEnum.enumValues)
  status?: FulfilmentStatus;
}

export class VendorOrderDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'FYK3M9QXWA' }) orderNumber: string;
  @ApiProperty({ enum: fulfilmentStatusEnum.enumValues }) status: FulfilmentStatus;
  @ApiProperty({ type: [OrderLineDto] }) lines: OrderLineDto[];
  @ApiProperty({ type: PriceDto }) subtotal: PriceDto;

  @ApiProperty({ example: 500, description: 'Commission in basis points (500 = 5%).' })
  commissionBps: number;

  @ApiProperty({ type: PriceDto }) commission: PriceDto;

  @ApiProperty({ type: PriceDto, description: 'What reaches the wallet: subtotal minus commission.' })
  payout: PriceDto;

  @ApiProperty({
    enum: escrowStatusEnum.enumValues,
    description:
      '`held`: paid, in escrow (shown as pending balance). `released`/`paid_out`: on its way / in the wallet. `disputed`: the customer reported a problem.',
  })
  escrowStatus: EscrowStatus;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  autoReleaseAt: Date | null;

  @ApiProperty() customerName: string;
  @ApiProperty({ type: AddressDto }) deliveryAddress: AddressDto;
  @ApiProperty({ nullable: true }) carrier: string | null;
  @ApiProperty({ nullable: true }) trackingNumber: string | null;
  @ApiProperty({ nullable: true }) problemReason: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) paidAt: Date | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) shippedAt: Date | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) deliveredAt: Date | null;
}

export class VendorStatusDto {
  @ApiProperty({ enum: ['processing', 'shipped', 'delivered'] })
  @IsIn(['processing', 'shipped', 'delivered'])
  status: 'processing' | 'shipped' | 'delivered';

  @ApiPropertyOptional({ example: 'GIG Logistics', maxLength: 80 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  carrier?: string;

  @ApiPropertyOptional({
    example: 'GIG-4471-2209',
    maxLength: 80,
    description: 'Required when marking `shipped` (PRD V8: vendor adds tracking).',
  })
  @ValidateIf((o: VendorStatusDto) => o.status === 'shipped' || o.trackingNumber !== undefined)
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(80)
  trackingNumber?: string;
}
