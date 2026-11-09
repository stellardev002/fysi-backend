import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PriceDto } from '../../products/dto/products.dto.js';

const PIN = /^\d{6}$/;

export class CreateWalletDto {
  @ApiProperty({ example: '482913', description: '6-digit PIN that confirms each payment (PRD).' })
  @Matches(PIN, { message: 'pin must be 6 digits' })
  pin: string;
}

export class ChangePinDto {
  @ApiProperty({ example: 'correct-horse-battery' })
  @IsString()
  @MaxLength(128)
  password: string;

  @ApiProperty({ example: '730184' })
  @Matches(PIN, { message: 'newPin must be 6 digits' })
  newPin: string;
}

export class WalletActivityDto {
  @ApiProperty({ enum: ['in', 'out'] }) direction: 'in' | 'out';
  @ApiProperty({ example: '25.5' }) amount: string;
  @ApiProperty({ example: 'USDC' }) assetCode: string;
  @ApiProperty({ description: 'The other party.' }) counterparty: string;
  @ApiProperty({ nullable: true, example: 'FYK3M9QXWA' }) memo: string | null;
  @ApiProperty() txHash: string;
  @ApiProperty() explorerUrl: string;
  @ApiProperty() at: Date;
}

export class CustomerWalletDto {
  @ApiProperty({ description: 'Deposit address (G…). Fund it with USDC on Stellar.' })
  address: string;

  @ApiProperty({
    enum: ['pending', 'active'],
    description: '`pending` while the account opens on the network (usually seconds).',
  })
  status: 'pending' | 'active';

  @ApiProperty({ example: '40.25', description: 'USDC balance.' })
  balance: string;

  @ApiProperty({ example: 1, description: 'KYC tier: 1 = email + phone (capped), 2 = BVN/NIN (pilot).' })
  kycTier: number;

  @ApiProperty({ type: PriceDto, nullable: true, description: 'Tier 1 balance cap; null without a cap.' })
  balanceCap: PriceDto | null;

  @ApiProperty({ description: 'The balance is above the tier cap: verify identity to lift it.' })
  overCap: boolean;

  @ApiProperty({
    example: 'web+stellar:pay?destination=G…&asset_code=USDC&asset_issuer=G…',
    description: 'SEP-7 request to fund the wallet: render as a QR code (PRD C9).',
  })
  depositUri: string;

  @ApiProperty({ type: [WalletActivityDto], description: 'Latest 20 payments, newest first.' })
  activity: WalletActivityDto[];
}

export class TransferViewDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ enum: ['payout', 'withdrawal'] }) kind: 'payout' | 'withdrawal';
  @ApiProperty({ example: '23.75' }) amount: string;
  @ApiProperty({ nullable: true, example: 'FYK3M9QXWA', description: 'Order number for payouts.' })
  orderNumber: string | null;
  @ApiProperty({ nullable: true, description: 'Destination address for withdrawals.' })
  destination: string | null;
  @ApiProperty({ enum: ['awaiting_confirmation', 'queued', 'submitted', 'confirmed', 'failed'] })
  status: string;
  @ApiProperty({ nullable: true }) txHash: string | null;
  @ApiProperty({ nullable: true }) explorerUrl: string | null;
  @ApiProperty({ nullable: true }) error: string | null;
  @ApiProperty() createdAt: Date;
}

export class VendorWalletDto {
  @ApiProperty({ nullable: true, description: 'Custodial wallet address; null until approval.' })
  address: string | null;

  @ApiProperty({ enum: ['pending', 'active', 'none'] }) status: 'pending' | 'active' | 'none';

  @ApiProperty({ type: PriceDto, description: 'USDC in the wallet now (PRD V5 "available").' })
  available: PriceDto;

  @ApiProperty({
    type: PriceDto,
    description: 'Paid orders still in escrow or on their way (PRD V5 "pending").',
  })
  pending: PriceDto;

  @ApiProperty({ type: PriceDto, description: 'What can still be withdrawn in the next 24 hours.' })
  withdrawableToday: PriceDto;

  @ApiProperty({ type: [TransferViewDto], description: 'Payouts and withdrawals, newest first.' })
  history: TransferViewDto[];
}

export class WithdrawDto {
  @ApiProperty({ description: 'External Stellar address (G…) that holds a USDC trustline.' })
  @Matches(/^G[A-Z2-7]{55}$/, { message: 'destination must be a Stellar G… address' })
  destination: string;

  @ApiProperty({ example: 5000, description: 'US cents ($50.00 = 5000).' })
  @IsInt()
  @Min(100)
  @Max(100_000_000)
  amountCents: number;
}

export class ConfirmWithdrawalDto {
  @ApiProperty({ example: 'correct-horse-battery' })
  @IsString()
  @MaxLength(128)
  password: string;

  @ApiProperty({ example: '482913', description: 'Code from the email.' })
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code: string;
}

export class WithdrawalDto extends TransferViewDto {
  @ApiPropertyOptional({ description: 'Confirm before this time.' })
  confirmBy?: Date;
}
