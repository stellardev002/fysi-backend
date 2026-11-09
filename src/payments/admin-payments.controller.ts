import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiParam, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser } from '../auth/decorators.js';
import { Roles } from '../authorization/roles.decorator.js';
import { ApiRoute } from '../common/api-docs.js';
import type { Page } from '../common/pagination.js';
import { STAFF_ROLES } from '../database/schema/index.js';
import { AdminPaymentsService } from './admin-payments.service.js';
import {
  AdminPaymentDto,
  AdminPaymentsQueryDto,
  AdminTransferDto,
  AdminTransfersQueryDto,
  AdminVendorOrderDto,
  AdminVendorOrdersQueryDto,
  DashboardDto,
  DashboardQueryDto,
  ReasonDto,
  TRANSFER_KINDS,
} from './dto/admin-payments.dto.js';
import { EscrowService } from './escrow.service.js';
import type { TransferKind } from './payments.queries.js';
import { ParseEnumPipe } from '@nestjs/common';

const ERRORS = [HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN];

@ApiTags('Admin Payments')
@ApiBearerAuth()
@Roles(...STAFF_ROLES)
@Controller('admin')
export class AdminPaymentsController {
  constructor(
    private readonly admin: AdminPaymentsService,
    private readonly escrow: EscrowService,
  ) {}

  @ApiRoute({
    summary: 'Dashboard',
    path: '/api/v1/admin/dashboard',
    description:
      'PRD A2: new vendors, new customers, paid orders, payment volume and failed (unmatched) payments per day or week, plus the queues waiting for an admin.',
    message: 'Dashboard retrieved',
    model: DashboardDto,
    errors: [HttpStatus.BAD_REQUEST, ...ERRORS],
  })
  @Get('dashboard')
  dashboard(@Query() q: DashboardQueryDto): Promise<DashboardDto> {
    return this.admin.dashboard(q);
  }

  @ApiRoute({
    summary: 'Transaction monitor',
    path: '/api/v1/admin/payments',
    description:
      'PRD A4: every payment into the settlement account with order, payer, amount, status and explorer link. `needsRefund=true` lists flagged payments (unmatched, overpaid, or for orders that expired part-paid).',
    message: 'Payments retrieved',
    model: AdminPaymentDto,
    paginated: true,
    errors: [HttpStatus.BAD_REQUEST, ...ERRORS],
  })
  @Get('payments')
  payments(@Query() q: AdminPaymentsQueryDto): Promise<Page<AdminPaymentDto>> {
    return this.admin.payments(q);
  }

  @HttpCode(HttpStatus.ACCEPTED)
  @ApiRoute({
    summary: 'Refund a flagged payment',
    path: '/api/v1/admin/payments/{id}/refund',
    description:
      'Sends the refundable amount back to the paying address in USDC (PRD: manual refunds by an admin; Fysi pays the fee). Queued at once; follow it in `GET /admin/transfers/refund`.',
    message: 'Refund queued',
    status: HttpStatus.ACCEPTED,
    errors: [
      { status: HttpStatus.BAD_REQUEST, message: 'Nothing on this payment is due back' },
      ...ERRORS,
      { status: HttpStatus.NOT_FOUND, message: 'Payment not found' },
      { status: HttpStatus.CONFLICT, message: 'A refund for this payment is already on its way' },
    ],
  })
  @Post('payments/:id/refund')
  refundPayment(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonDto,
  ): Promise<void> {
    return this.escrow.refundPayment(admin.id, id, dto.reason);
  }

  @ApiRoute({
    summary: 'Vendor orders and disputes',
    path: '/api/v1/admin/vendor-orders',
    description: '`escrowStatus=disputed` is the problem-report queue.',
    message: 'Vendor orders retrieved',
    model: AdminVendorOrderDto,
    paginated: true,
    errors: [HttpStatus.BAD_REQUEST, ...ERRORS],
  })
  @Get('vendor-orders')
  vendorOrders(@Query() q: AdminVendorOrdersQueryDto): Promise<Page<AdminVendorOrderDto>> {
    return this.admin.vendorOrders(q);
  }

  @HttpCode(HttpStatus.ACCEPTED)
  @ApiRoute({
    summary: 'Release escrow to the vendor',
    path: '/api/v1/admin/vendor-orders/{id}/release',
    description: 'Resolves a dispute in the vendor’s favour (or releases a held order early). Queues the payout.',
    message: 'Payout queued',
    status: HttpStatus.ACCEPTED,
    errors: [HttpStatus.BAD_REQUEST, ...ERRORS, { status: HttpStatus.NOT_FOUND, message: 'Vendor order not found' }, HttpStatus.CONFLICT],
  })
  @Post('vendor-orders/:id/release')
  release(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonDto,
  ): Promise<void> {
    return this.escrow.adminRelease(admin.id, id, dto.reason);
  }

  @HttpCode(HttpStatus.ACCEPTED)
  @ApiRoute({
    summary: 'Cancel and refund a vendor order',
    path: '/api/v1/admin/vendor-orders/{id}/refund',
    description:
      'Before payout only (PRD refund decision: non-delivery, damage or wrong item; personal care only if unopened). Refunds the vendor order’s full subtotal to the address that paid and cancels it.',
    message: 'Refund queued',
    status: HttpStatus.ACCEPTED,
    errors: [HttpStatus.BAD_REQUEST, ...ERRORS, { status: HttpStatus.NOT_FOUND, message: 'Vendor order not found' }, HttpStatus.CONFLICT],
  })
  @Post('vendor-orders/:id/refund')
  refundVendorOrder(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonDto,
  ): Promise<void> {
    return this.escrow.refundVendorOrder(admin.id, id, dto.reason);
  }

  @ApiParam({ name: 'kind', enum: TRANSFER_KINDS })
  @ApiRoute({
    summary: 'Payouts, refunds or withdrawals',
    path: '/api/v1/admin/transfers/{kind}',
    description: 'Platform-sent USDC by kind, with status, attempts and the last error.',
    message: 'Transfers retrieved',
    model: AdminTransferDto,
    paginated: true,
    errors: [HttpStatus.BAD_REQUEST, ...ERRORS],
  })
  @Get('transfers/:kind')
  transfers(
    @Param('kind', new ParseEnumPipe(TRANSFER_KINDS)) kind: TransferKind,
    @Query() q: AdminTransfersQueryDto,
  ): Promise<Page<AdminTransferDto>> {
    return this.admin.transfers(kind, q);
  }

  @ApiParam({ name: 'kind', enum: TRANSFER_KINDS })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiRoute({
    summary: 'Retry a failed transfer',
    path: '/api/v1/admin/transfers/{kind}/{id}/retry',
    message: 'Transfer queued again',
    status: HttpStatus.ACCEPTED,
    errors: [...ERRORS, { status: HttpStatus.NOT_FOUND, message: 'Transfer not found' }, HttpStatus.CONFLICT],
  })
  @Post('transfers/:kind/:id/retry')
  retry(
    @CurrentUser() admin: AuthUser,
    @Param('kind', new ParseEnumPipe(TRANSFER_KINDS)) kind: TransferKind,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.admin.retry(admin.id, kind, id);
  }
}
