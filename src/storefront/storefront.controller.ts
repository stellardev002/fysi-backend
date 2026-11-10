import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser } from '../auth/decorators.js';
import { Roles } from '../authorization/roles.decorator.js';
import { ApiRoute } from '../common/api-docs.js';
import { type Page, PaginationQueryDto } from '../common/pagination.js';
import {
  SaveAddressDto,
  SavedAddressDto,
  UpdateAddressDto,
  WishlistItemDto,
  WishlistStatusDto,
} from './dto/storefront.dto.js';
import { StorefrontService } from './storefront.service.js';

const CUSTOMER_ERRORS = [
  HttpStatus.UNAUTHORIZED,
  { status: HttpStatus.FORBIDDEN, description: 'Only customer accounts.' },
];

const ADDRESS_EXAMPLE = {
  id: '0197c2c1-1111-7a2b-b3c4-1d2e3f4a5b6c',
  label: 'Home',
  recipientName: 'Grace Ajayi',
  phone: '+2348031234567',
  line1: '14 Bourdillon Road',
  line2: null,
  city: 'Ikoyi',
  state: 'Lagos',
  notes: 'Call on arrival',
  isDefault: true,
  createdAt: '2026-11-10T09:30:00.000Z',
  updatedAt: '2026-11-10T09:30:00.000Z',
};
const ADDRESS_NOT_FOUND = { status: HttpStatus.NOT_FOUND, message: 'Address not found' };

@ApiTags('Wishlist')
@ApiBearerAuth()
@Roles('customer')
@Controller('wishlist')
export class WishlistController {
  constructor(private readonly storefront: StorefrontService) {}

  @ApiRoute({
    summary: 'My wishlist',
    path: '/api/v1/wishlist',
    description:
      'Saved products, newest first, with live prices. A product no longer on sale stays listed with `product: null`.',
    message: 'Wishlist retrieved',
    model: WishlistItemDto,
    paginated: true,
    errors: CUSTOMER_ERRORS,
  })
  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: PaginationQueryDto): Promise<Page<WishlistItemDto>> {
    return this.storefront.wishlist(user.id, q);
  }

  @ApiRoute({
    summary: 'Is this product saved?',
    path: '/api/v1/wishlist/{productId}',
    description: 'For the heart icon on a product page.',
    message: 'Wishlist status retrieved',
    model: WishlistStatusDto,
    example: { productId: '0197c2b0-1111-7a2b-b3c4-1d2e3f4a5b6c', saved: true, count: 12 },
    errors: CUSTOMER_ERRORS,
  })
  @Get(':productId')
  status(
    @CurrentUser() user: AuthUser,
    @Param('productId', ParseUUIDPipe) productId: string,
  ): Promise<WishlistStatusDto> {
    return this.storefront.status(user.id, productId);
  }

  @ApiRoute({
    summary: 'Save a product',
    path: '/api/v1/wishlist/{productId}',
    description: 'Saving twice changes nothing. Up to 200 products.',
    message: 'Saved to wishlist',
    model: WishlistStatusDto,
    example: { productId: '0197c2b0-1111-7a2b-b3c4-1d2e3f4a5b6c', saved: true, count: 12 },
    errors: [
      ...CUSTOMER_ERRORS,
      { status: HttpStatus.NOT_FOUND, message: 'Product not found', description: 'Not on sale.' },
      { status: HttpStatus.CONFLICT, message: 'A wishlist holds at most 200 products' },
    ],
  })
  @Put(':productId')
  save(
    @CurrentUser() user: AuthUser,
    @Param('productId', ParseUUIDPipe) productId: string,
  ): Promise<WishlistStatusDto> {
    return this.storefront.save(user.id, productId);
  }

  @ApiRoute({
    summary: 'Remove a product',
    path: '/api/v1/wishlist/{productId}',
    message: 'Removed from wishlist',
    model: WishlistStatusDto,
    example: { productId: '0197c2b0-1111-7a2b-b3c4-1d2e3f4a5b6c', saved: false, count: 11 },
    errors: CUSTOMER_ERRORS,
  })
  @Delete(':productId')
  unsave(
    @CurrentUser() user: AuthUser,
    @Param('productId', ParseUUIDPipe) productId: string,
  ): Promise<WishlistStatusDto> {
    return this.storefront.unsave(user.id, productId);
  }
}

@ApiTags('Saved Addresses')
@ApiBearerAuth()
@Roles('customer')
@Controller('addresses')
export class AddressesController {
  constructor(private readonly storefront: StorefrontService) {}

  @ApiRoute({
    summary: 'My saved addresses',
    path: '/api/v1/addresses',
    description: 'Default first. Check out with one by sending its id as `addressId` to `POST /checkout`.',
    message: 'Addresses retrieved',
    model: SavedAddressDto,
    example: [ADDRESS_EXAMPLE],
    errors: CUSTOMER_ERRORS,
  })
  @Get()
  list(@CurrentUser() user: AuthUser): Promise<SavedAddressDto[]> {
    return this.storefront.addresses(user.id);
  }

  @ApiRoute({
    summary: 'One saved address',
    path: '/api/v1/addresses/{id}',
    message: 'Address retrieved',
    model: SavedAddressDto,
    example: ADDRESS_EXAMPLE,
    errors: [...CUSTOMER_ERRORS, ADDRESS_NOT_FOUND],
  })
  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<SavedAddressDto> {
    return this.storefront.address(user.id, id);
  }

  @ApiRoute({
    summary: 'Save an address',
    path: '/api/v1/addresses',
    description: 'Up to 10. The first one becomes the default.',
    message: 'Address saved',
    status: HttpStatus.CREATED,
    model: SavedAddressDto,
    example: ADDRESS_EXAMPLE,
    errors: [
      HttpStatus.BAD_REQUEST,
      ...CUSTOMER_ERRORS,
      { status: HttpStatus.CONFLICT, message: 'You can save up to 10 addresses' },
    ],
  })
  @Post()
  add(@CurrentUser() user: AuthUser, @Body() dto: SaveAddressDto): Promise<SavedAddressDto> {
    return this.storefront.addAddress(user.id, dto);
  }

  @ApiRoute({
    summary: 'Edit an address',
    path: '/api/v1/addresses/{id}',
    description: 'Partial update. Orders already placed keep the address they were placed with.',
    message: 'Address updated',
    model: SavedAddressDto,
    example: ADDRESS_EXAMPLE,
    errors: [HttpStatus.BAD_REQUEST, ...CUSTOMER_ERRORS, ADDRESS_NOT_FOUND],
  })
  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAddressDto,
  ): Promise<SavedAddressDto> {
    return this.storefront.updateAddress(user.id, id, dto);
  }

  @HttpCode(HttpStatus.OK)
  @ApiRoute({
    summary: 'Make it the default',
    path: '/api/v1/addresses/{id}/default',
    message: 'Default address updated',
    model: SavedAddressDto,
    example: ADDRESS_EXAMPLE,
    errors: [...CUSTOMER_ERRORS, ADDRESS_NOT_FOUND],
  })
  @Post(':id/default')
  setDefault(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<SavedAddressDto> {
    return this.storefront.setDefault(user.id, id);
  }

  @ApiRoute({
    summary: 'Delete an address',
    path: '/api/v1/addresses/{id}',
    description: 'Deleting the default makes the oldest remaining address the default.',
    message: 'Address deleted',
    errors: [...CUSTOMER_ERRORS, ADDRESS_NOT_FOUND],
  })
  @Delete(':id')
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<null> {
    await this.storefront.removeAddress(user.id, id);
    return null;
  }
}
