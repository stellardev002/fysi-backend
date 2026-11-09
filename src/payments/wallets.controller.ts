import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser } from '../auth/decorators.js';
import { Roles } from '../authorization/roles.decorator.js';
import { ApiRoute } from '../common/api-docs.js';
import { RateLimit } from '../rate-limit/rate-limit.decorator.js';
import {
  ChangePinDto,
  ConfirmWithdrawalDto,
  CreateWalletDto,
  CustomerWalletDto,
  VendorWalletDto,
  WithdrawalDto,
  WithdrawDto,
} from './dto/wallets.dto.js';
import { WalletAccountsService } from './wallet-accounts.service.js';

const SENSITIVE = { capacity: 5, refillPerSec: 1 / 12 };

@ApiTags('Customer Wallet')
@ApiBearerAuth()
@Roles('customer')
@Controller('wallet')
export class CustomerWalletController {
  constructor(private readonly accounts: WalletAccountsService) {}

  @ApiRoute({
    summary: 'Create my Fysi wallet',
    path: '/api/v1/wallet',
    description: `Opt-in custodial wallet (PRD C9). No seed phrase: Fysi holds the key, and each payment needs this PIN.

- Needs a phone number on the account (KYC Tier 1: email + phone, balance capped at about $200; Tier 2 with BVN/NIN lifts it at the pilot).
- Fysi pays the network reserve and fees: the wallet only ever holds USDC.
- Fund it by sending USDC on Stellar to \`address\` (or scanning \`depositUri\`).`,
    message: 'Wallet created',
    status: HttpStatus.CREATED,
    model: CustomerWalletDto,
    errors: [
      { status: HttpStatus.BAD_REQUEST, message: 'Add your phone number first (PATCH /auth/me): Tier 1 wallets need email and phone' },
      HttpStatus.UNAUTHORIZED,
      HttpStatus.FORBIDDEN,
      { status: HttpStatus.CONFLICT, message: 'You already have a Fysi wallet' },
    ],
  })
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateWalletDto): Promise<CustomerWalletDto> {
    return this.accounts.createCustomerWallet(user, dto.pin);
  }

  @ApiRoute({
    summary: 'My Fysi wallet',
    path: '/api/v1/wallet',
    description: 'Balance, deposit address and QR request, tier and cap, and the latest payments with explorer links (PRD C9).',
    message: 'Wallet retrieved',
    model: CustomerWalletDto,
    errors: [HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN, { status: HttpStatus.NOT_FOUND, message: 'No Fysi wallet yet' }],
  })
  @Get()
  get(@CurrentUser() user: AuthUser): Promise<CustomerWalletDto> {
    return this.accounts.customerWallet(user.id);
  }

  @RateLimit(SENSITIVE)
  @ApiRoute({
    summary: 'Change my wallet PIN',
    path: '/api/v1/wallet/pin',
    message: 'PIN changed',
    errors: [{ status: HttpStatus.BAD_REQUEST, message: 'Password is incorrect' }, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN],
  })
  @Put('pin')
  changePin(@CurrentUser() user: AuthUser, @Body() dto: ChangePinDto): Promise<void> {
    return this.accounts.changePin(user, dto.password, dto.newPin);
  }
}

@ApiTags('Vendor Wallet')
@ApiBearerAuth()
@Roles('vendor')
@Controller('vendor/wallet')
export class VendorWalletController {
  constructor(private readonly accounts: WalletAccountsService) {}

  @ApiRoute({
    summary: 'My wallet',
    path: '/api/v1/vendor/wallet',
    description:
      'PRD V5: available USDC, pending (escrow) balance, what can be withdrawn today, and payouts and withdrawals with explorer links. The wallet is created automatically on approval; no seed phrase.',
    message: 'Wallet retrieved',
    model: VendorWalletDto,
    errors: [HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN],
  })
  @Get()
  get(@CurrentUser() user: AuthUser): Promise<VendorWalletDto> {
    return this.accounts.vendorWallet(user.id);
  }

  @RateLimit(SENSITIVE)
  @ApiRoute({
    summary: 'Start a withdrawal',
    path: '/api/v1/vendor/wallet/withdrawals',
    description:
      'PRD V6: USDC to an external Stellar address that trusts USDC, within the daily limit. Emails a 6-digit code; finish with `POST /vendor/wallet/withdrawals/{id}/confirm` and your password. Bank cash-out arrives with the NGN anchor at the pilot.',
    message: 'Check your email for the confirmation code',
    status: HttpStatus.CREATED,
    model: WithdrawalDto,
    errors: [
      { status: HttpStatus.BAD_REQUEST, message: 'That is over the daily withdrawal limit: $100.00 left today' },
      HttpStatus.UNAUTHORIZED,
      HttpStatus.FORBIDDEN,
      { status: HttpStatus.CONFLICT, message: 'Your wallet is not open yet; it is created when your business is approved' },
      HttpStatus.TOO_MANY_REQUESTS,
    ],
  })
  @Post('withdrawals')
  withdraw(@CurrentUser() user: AuthUser, @Body() dto: WithdrawDto): Promise<WithdrawalDto> {
    return this.accounts.requestWithdrawal(user, dto);
  }

  @RateLimit(SENSITIVE)
  @HttpCode(HttpStatus.OK)
  @ApiRoute({
    summary: 'Confirm a withdrawal',
    path: '/api/v1/vendor/wallet/withdrawals/{id}/confirm',
    description: 'Password plus the emailed code. The USDC is sent at once; `status` shows the outcome.',
    message: 'Withdrawal sent',
    model: WithdrawalDto,
    errors: [
      { status: HttpStatus.BAD_REQUEST, message: 'Password or code is incorrect' },
      HttpStatus.UNAUTHORIZED,
      HttpStatus.FORBIDDEN,
      { status: HttpStatus.NOT_FOUND, message: 'Withdrawal not found' },
      HttpStatus.CONFLICT,
      HttpStatus.TOO_MANY_REQUESTS,
    ],
  })
  @Post('withdrawals/:id/confirm')
  confirm(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmWithdrawalDto,
  ): Promise<WithdrawalDto> {
    return this.accounts.confirmWithdrawal(user, id, dto.password, dto.code);
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiRoute({
    summary: 'Cancel an unconfirmed withdrawal',
    path: '/api/v1/vendor/wallet/withdrawals/{id}',
    message: 'Withdrawal cancelled',
    status: HttpStatus.NO_CONTENT,
    errors: [HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN, { status: HttpStatus.NOT_FOUND, message: 'Withdrawal not found' }, HttpStatus.CONFLICT],
  })
  @Delete('withdrawals/:id')
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.accounts.cancelWithdrawal(user, id);
  }
}
