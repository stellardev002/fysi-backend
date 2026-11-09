import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, Public } from '../auth/decorators.js';
import { Roles } from '../authorization/roles.decorator.js';
import { ApiRoute } from '../common/api-docs.js';
import { type Page, PaginationQueryDto } from '../common/pagination.js';
import { RateLimit } from '../rate-limit/rate-limit.decorator.js';
import {
  CheckoutDto,
  ExternalPrepareDto,
  ExternalSubmitDto,
  OrderDto,
  PayPageDto,
  PreparedPaymentDto,
  ProblemDto,
  VendorOrderDto,
  VendorOrdersQueryDto,
  VendorStatusDto,
  WalletPayDto,
} from './dto/orders.dto.js';
import { OrdersService } from './orders.service.js';

const CUSTOMER_ERRORS = [HttpStatus.UNAUTHORIZED, { status: HttpStatus.FORBIDDEN, description: 'Customers only.' }];
const NOT_FOUND = { status: HttpStatus.NOT_FOUND, message: 'Order not found' };
const NOT_PAYABLE = {
  status: HttpStatus.CONFLICT,
  description: 'The order is paid, expired or cancelled, or its payment window closed.',
  message: 'This order is paid',
};
const PAY_ATTEMPTS = { capacity: 10, refillPerSec: 1 / 6 };

@ApiTags('Checkout & Orders')
@Controller()
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @ApiBearerAuth()
  @Roles('customer')
  @ApiRoute({
    summary: 'Check out the cart',
    path: '/api/v1/checkout',
    description: `Creates the order from the cart (PRD C5–C6). Stock is held for 15 minutes; the order is split per vendor (multi-vendor cart, one payment).

Pay with any of the four methods, all of which pay the Fysi settlement account in USDC with the order number as memo:
1. **External wallet**: \`POST /orders/{id}/pay/external\` then \`/pay/external/submit\`.
2. **Fysi wallet**: \`POST /orders/{id}/pay/wallet\` with the PIN.
3. **QR code**: render \`payment.sep7Uri\`; any SEP-7 Stellar wallet can scan it.
4. **Payment link**: share \`payment.payLink\` (the pay page reads \`GET /pay/{token}\`).

Poll \`GET /orders/{id}\` until \`status\` is \`paid\` (usually seconds). An underpayment leaves the balance in \`payment.amountDue\`.`,
    message: 'Order created. Pay within 15 minutes',
    status: HttpStatus.CREATED,
    model: OrderDto,
    errors: [
      { status: HttpStatus.BAD_REQUEST, message: 'Your cart is empty' },
      ...CUSTOMER_ERRORS,
      {
        status: HttpStatus.CONFLICT,
        description: 'Stock or availability changed; `error.details` lists what.',
        message: 'Some items in your cart changed. Review your cart and try again',
      },
      { status: HttpStatus.SERVICE_UNAVAILABLE, message: 'Payments are not available yet: the settlement account is not set up' },
    ],
  })
  @Post('checkout')
  checkout(@CurrentUser() user: AuthUser, @Body() dto: CheckoutDto): Promise<OrderDto> {
    return this.orders.checkout(user, dto);
  }

  @ApiBearerAuth()
  @Roles('customer')
  @ApiRoute({
    summary: 'My orders',
    path: '/api/v1/orders',
    description: 'Order history and status tracking (PRD C8), newest first.',
    message: 'Orders retrieved',
    model: OrderDto,
    paginated: true,
    errors: CUSTOMER_ERRORS,
  })
  @Get('orders')
  list(@CurrentUser() user: AuthUser, @Query() q: PaginationQueryDto): Promise<Page<OrderDto>> {
    return this.orders.list(user.id, q);
  }

  @ApiBearerAuth()
  @Roles('customer')
  @ApiRoute({
    summary: 'One order',
    path: '/api/v1/orders/{id}',
    description: 'Status, payment instructions while unpaid, transaction hashes with explorer links (PRD C7), and each vendor’s part with tracking.',
    message: 'Order retrieved',
    model: OrderDto,
    errors: [...CUSTOMER_ERRORS, NOT_FOUND],
  })
  @Get('orders/:id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<OrderDto> {
    return this.orders.get(user.id, id);
  }

  @ApiBearerAuth()
  @Roles('customer')
  @RateLimit(PAY_ATTEMPTS)
  @HttpCode(HttpStatus.OK)
  @ApiRoute({
    summary: 'Pay with an external wallet: prepare',
    path: '/api/v1/orders/{id}/pay/external',
    description:
      'Builds the exact payment (amount due, USDC, memo) from the customer’s wallet address. Sign it in the wallet (Freighter, LOBSTR, xBull, Albedo or a WalletConnect wallet) and send it to `/pay/external/submit`.',
    message: 'Sign this payment in your wallet',
    model: PreparedPaymentDto,
    errors: [
      { status: HttpStatus.BAD_REQUEST, message: 'This wallet cannot hold USDC: add the trustline first' },
      ...CUSTOMER_ERRORS,
      NOT_FOUND,
      NOT_PAYABLE,
      HttpStatus.SERVICE_UNAVAILABLE,
    ],
  })
  @Post('orders/:id/pay/external')
  prepare(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ExternalPrepareDto,
  ): Promise<PreparedPaymentDto> {
    return this.orders.prepareExternal(user.id, id, dto.sourceAddress);
  }

  @ApiBearerAuth()
  @Roles('customer')
  @RateLimit(PAY_ATTEMPTS)
  @HttpCode(HttpStatus.OK)
  @ApiRoute({
    summary: 'Pay with an external wallet: submit',
    path: '/api/v1/orders/{id}/pay/external/submit',
    description:
      'Submits the signed payment to Stellar and returns the order, normally already `paid`. Network rejections come back as 400 in plain words.',
    message: 'Payment submitted',
    model: OrderDto,
    errors: [
      { status: HttpStatus.BAD_REQUEST, message: 'Not enough USDC in the wallet for this amount' },
      ...CUSTOMER_ERRORS,
      NOT_FOUND,
      NOT_PAYABLE,
    ],
  })
  @Post('orders/:id/pay/external/submit')
  submit(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ExternalSubmitDto,
  ): Promise<OrderDto> {
    return this.orders.submitExternal(user.id, id, dto.signedTransaction);
  }

  @ApiBearerAuth()
  @Roles('customer')
  @RateLimit(PAY_ATTEMPTS)
  @HttpCode(HttpStatus.OK)
  @ApiRoute({
    summary: 'Pay with my Fysi wallet',
    path: '/api/v1/orders/{id}/pay/wallet',
    description:
      'One tap plus PIN (PRD C6). Blocked with a prompt to fund when the balance is too low. Five wrong PINs lock payments for 15 minutes.',
    message: 'Payment sent',
    model: OrderDto,
    errors: [
      ...CUSTOMER_ERRORS,
      { status: HttpStatus.FORBIDDEN, message: 'Wrong PIN' },
      NOT_FOUND,
      { status: HttpStatus.CONFLICT, message: 'Your Fysi wallet balance is too low. Fund it first' },
    ],
  })
  @Post('orders/:id/pay/wallet')
  payWallet(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: WalletPayDto,
  ): Promise<OrderDto> {
    return this.orders.payWithWallet(user.id, id, dto.pin);
  }

  @ApiBearerAuth()
  @Roles('customer')
  @HttpCode(HttpStatus.OK)
  @ApiRoute({
    summary: 'Cancel an unpaid order',
    path: '/api/v1/orders/{id}/cancel',
    description: 'Releases the held stock. Not possible once anything was paid.',
    message: 'Order cancelled',
    model: OrderDto,
    errors: [...CUSTOMER_ERRORS, NOT_FOUND, HttpStatus.CONFLICT],
  })
  @Post('orders/:id/cancel')
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<OrderDto> {
    return this.orders.cancel(user.id, id);
  }

  @ApiBearerAuth()
  @Roles('customer')
  @HttpCode(HttpStatus.OK)
  @ApiRoute({
    summary: 'Confirm delivery',
    path: '/api/v1/orders/{id}/vendor-orders/{vendorOrderId}/confirm-delivery',
    description: 'PRD C8: releases the vendor’s payout for that part of the order.',
    message: 'Delivery confirmed. Thank you!',
    model: OrderDto,
    errors: [...CUSTOMER_ERRORS, NOT_FOUND, { status: HttpStatus.CONFLICT, message: 'This part of the order cannot be confirmed now' }],
  })
  @Post('orders/:id/vendor-orders/:vendorOrderId/confirm-delivery')
  confirm(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('vendorOrderId', ParseUUIDPipe) voId: string,
  ): Promise<OrderDto> {
    return this.orders.confirmDelivery(user.id, id, voId);
  }

  @ApiBearerAuth()
  @Roles('customer')
  @HttpCode(HttpStatus.OK)
  @ApiRoute({
    summary: 'Report a problem',
    path: '/api/v1/orders/{id}/vendor-orders/{vendorOrderId}/problem',
    description:
      'PRD C8: from shipping until 7 days after delivery. Holds the vendor’s payout until an admin decides (refund or release).',
    message: 'Problem reported. The Fysi team will be in touch',
    model: OrderDto,
    errors: [HttpStatus.BAD_REQUEST, ...CUSTOMER_ERRORS, NOT_FOUND, HttpStatus.CONFLICT],
  })
  @Post('orders/:id/vendor-orders/:vendorOrderId/problem')
  problem(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('vendorOrderId', ParseUUIDPipe) voId: string,
    @Body() dto: ProblemDto,
  ): Promise<OrderDto> {
    return this.orders.reportProblem(user.id, id, voId, dto.reason);
  }

  @Public()
  @ApiRoute({
    summary: 'Pay page (payment link)',
    path: '/api/v1/pay/{token}',
    description:
      'Public, no account: what the hosted pay page shows (PRD: payment link the customer can open later or send to someone else). Items and amounts only; no address or personal data.',
    message: 'Payment details retrieved',
    model: PayPageDto,
    errors: [{ status: HttpStatus.NOT_FOUND, message: 'Payment link not found' }],
  })
  @Get('pay/:token')
  payPage(@Param('token') token: string): Promise<PayPageDto> {
    return this.orders.payPage(token);
  }
}

@ApiTags('Vendor Orders')
@ApiBearerAuth()
@Roles('vendor')
@Controller('vendor/orders')
export class VendorOrdersController {
  constructor(private readonly orders: OrdersService) {}

  @ApiRoute({
    summary: 'My orders',
    path: '/api/v1/vendor/orders',
    description: 'PRD V8: paid orders with status, payout breakdown and escrow state. Unpaid checkouts are not listed.',
    message: 'Orders retrieved',
    model: VendorOrderDto,
    paginated: true,
    errors: [HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN],
  })
  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: VendorOrdersQueryDto): Promise<Page<VendorOrderDto>> {
    return this.orders.vendorList(user.id, q);
  }

  @ApiRoute({
    summary: 'One order',
    path: '/api/v1/vendor/orders/{id}',
    description: 'Items, delivery address and contact for shipping, payout breakdown.',
    message: 'Order retrieved',
    model: VendorOrderDto,
    errors: [HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN, NOT_FOUND],
  })
  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<VendorOrderDto> {
    return this.orders.vendorGet(user.id, id);
  }

  @ApiRoute({
    summary: 'Update status',
    path: '/api/v1/vendor/orders/{id}/status',
    description: `PRD V8: \`processing\` → \`shipped\` (tracking number required; the customer is emailed) → \`delivered\`.

Shipping starts the 7-day timer after which escrow releases automatically. Marking delivered does not release payment by itself: the customer's confirmation or the timer does. To cancel a paid order, contact Fysi: an admin refunds the customer.`,
    message: 'Order updated',
    model: VendorOrderDto,
    errors: [HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN, NOT_FOUND, HttpStatus.CONFLICT],
  })
  @Patch(':id/status')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VendorStatusDto,
  ): Promise<VendorOrderDto> {
    return this.orders.vendorUpdate(user.id, id, dto);
  }
}
