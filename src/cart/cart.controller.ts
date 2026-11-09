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
import { CurrentUser, Public } from '../auth/decorators.js';
import { Roles } from '../authorization/roles.decorator.js';
import { ApiRoute } from '../common/api-docs.js';
import { RateLimit } from '../rate-limit/rate-limit.decorator.js';
import { CartService } from './cart.service.js';
import {
  CartDto,
  CartQuantityDto,
  GuestCartDto,
  MergeResultDto,
} from './dto/cart.dto.js';

const CART_EXAMPLE = {
  items: [
    {
      productId: '0197c2b0-1111-7a2b-b3c4-1d2e3f4a5b6c',
      quantity: 2,
      product: {
        id: '0197c2b0-1111-7a2b-b3c4-1d2e3f4a5b6c',
        slug: 'organic-cotton-tote-bag-k3x9qa',
        title: 'Organic cotton tote bag',
        price: { cents: 1250, usd: '12.50' },
        inStock: true,
        imageUrl: null,
        badge: 'certified',
        certifications: [{ id: 'gots', name: 'GOTS' }],
        category: {
          id: '0197c2a4-5b1e-7d3a-9c10-6f2e8b4a1d55',
          name: 'Household items',
          slug: 'household',
        },
        vendor: {
          slug: 'ecothreads-lagos',
          businessName: 'EcoThreads Lagos',
          verified: true,
          badge: 'certified',
        },
        createdAt: '2026-11-08T09:30:00.000Z',
      },
      lineTotal: { cents: 2500, usd: '25.00' },
      maxQuantity: 40,
      issue: null,
    },
  ],
  subtotal: { cents: 2500, usd: '25.00' },
  itemCount: 2,
  vendorCount: 1,
  readyForCheckout: true,
};

const CUSTOMER_ERRORS = [
  HttpStatus.UNAUTHORIZED,
  {
    status: HttpStatus.FORBIDDEN,
    description: 'Only customer accounts have a cart.',
  },
];

@ApiTags('Cart')
@Controller('cart')
export class CartController {
  constructor(private readonly cart: CartService) {}

  @Public()
  @RateLimit({ capacity: 30, refillPerSec: 1 })
  @HttpCode(HttpStatus.OK)
  @ApiRoute({
    summary: 'Price a guest cart',
    path: '/api/v1/cart/preview',
    description: `No account needed (PRD C4). Guests keep their cart in the browser; send it here to show live prices, stock and issues. Nothing is stored.

At checkout the guest signs up or logs in, then \`POST /cart/merge\` moves this cart into the account.`,
    message: 'Cart priced',
    model: CartDto,
    example: CART_EXAMPLE,
    errors: [HttpStatus.BAD_REQUEST, HttpStatus.TOO_MANY_REQUESTS],
  })
  @Post('preview')
  preview(@Body() dto: GuestCartDto): Promise<CartDto> {
    return this.cart.preview(dto.items);
  }

  @ApiBearerAuth()
  @Roles('customer')
  @ApiRoute({
    summary: 'My cart',
    path: '/api/v1/cart',
    description:
      'Live prices and stock. Lines that can no longer be bought stay listed with an `issue` and are left out of the subtotal; `readyForCheckout` is false until they are fixed.',
    message: 'Cart retrieved',
    model: CartDto,
    example: CART_EXAMPLE,
    errors: CUSTOMER_ERRORS,
  })
  @Get()
  get(@CurrentUser() user: AuthUser): Promise<CartDto> {
    return this.cart.get(user.id);
  }

  @ApiBearerAuth()
  @Roles('customer')
  @ApiRoute({
    summary: 'Merge the guest cart into my account',
    path: '/api/v1/cart/merge',
    description: `Call once after sign-up or login with the browser cart (PRD C4: "the cart is kept"), then clear the browser copy.

- A product already in the account keeps the larger of the two quantities, so repeating the call never doubles anything.
- Quantities are capped by stock; products no longer sold come back in \`skipped\`.`,
    message: 'Cart merged',
    model: MergeResultDto,
    example: { ...CART_EXAMPLE, skipped: [] },
    errors: [HttpStatus.BAD_REQUEST, ...CUSTOMER_ERRORS],
  })
  @HttpCode(HttpStatus.OK)
  @Post('merge')
  merge(
    @CurrentUser() user: AuthUser,
    @Body() dto: GuestCartDto,
  ): Promise<MergeResultDto> {
    return this.cart.merge(user.id, dto.items);
  }

  @ApiBearerAuth()
  @Roles('customer')
  @ApiRoute({
    summary: 'Add a product or set its quantity',
    path: '/api/v1/cart/items/{productId}',
    description:
      'Sets the quantity (1–99), adding the line if needed. Up to 50 different products.',
    message: 'Cart updated',
    model: CartDto,
    example: CART_EXAMPLE,
    errors: [
      HttpStatus.BAD_REQUEST,
      ...CUSTOMER_ERRORS,
      {
        status: HttpStatus.NOT_FOUND,
        message: 'Product not found',
        description: 'Not on sale.',
      },
      {
        status: HttpStatus.CONFLICT,
        message: 'Only 3 left in stock',
        description: 'Sold out, more than the stock, or the cart is full.',
      },
    ],
  })
  @Put('items/:productId')
  set(
    @CurrentUser() user: AuthUser,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: CartQuantityDto,
  ): Promise<CartDto> {
    return this.cart.setQuantity(user.id, productId, dto.quantity);
  }

  @ApiBearerAuth()
  @Roles('customer')
  @ApiRoute({
    summary: 'Remove a product',
    path: '/api/v1/cart/items/{productId}',
    description: 'Removing a product that is not in the cart changes nothing.',
    message: 'Cart updated',
    model: CartDto,
    example: CART_EXAMPLE,
    errors: CUSTOMER_ERRORS,
  })
  @Delete('items/:productId')
  remove(
    @CurrentUser() user: AuthUser,
    @Param('productId', ParseUUIDPipe) productId: string,
  ): Promise<CartDto> {
    return this.cart.remove(user.id, productId);
  }

  @ApiBearerAuth()
  @Roles('customer')
  @ApiRoute({
    summary: 'Empty the cart',
    path: '/api/v1/cart',
    message: 'Cart emptied',
    model: CartDto,
    errors: CUSTOMER_ERRORS,
  })
  @Delete()
  clear(@CurrentUser() user: AuthUser): Promise<CartDto> {
    return this.cart.clear(user.id);
  }
}
