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
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser } from '../auth/decorators.js';
import { Roles } from '../authorization/roles.decorator.js';
import { ApiErrors, ApiRoute } from '../common/api-docs.js';
import type { Page } from '../common/pagination.js';
import { MAX_IMAGE_BYTES, type UploadedImage } from '../storage/images.js';
import {
  CreateProductDto,
  ImageOrderDto,
  UpdateProductDto,
  VendorProductDto,
  VendorProductsQueryDto,
} from './dto/products.dto.js';
import { ProductsService } from './products.service.js';

export const PRODUCT_EXAMPLE = {
  id: '0197c2b0-1111-7a2b-b3c4-1d2e3f4a5b6c',
  slug: 'organic-cotton-tote-bag-k3x9qa',
  title: 'Organic cotton tote bag',
  description: 'Hand-stitched from GOTS-certified cotton. Holds 15 kg.',
  price: { cents: 1250, usd: '12.50' },
  stock: 40,
  category: {
    id: '0197c2a4-5b1e-7d3a-9c10-6f2e8b4a1d55',
    name: 'Household items',
    slug: 'household',
  },
  certifications: [{ id: 'gots', name: 'GOTS' }],
  badge: 'certified',
  status: 'active',
  moderationStatus: 'visible',
  moderationReason: null,
  isPublic: true,
  images: [
    {
      id: '0197c2b0-2222-7a2b-b3c4-1d2e3f4a5b6c',
      url: 'https://<bucket>.t3.storageapi.dev/products/…?X-Amz-Signature=…',
      position: 0,
    },
  ],
  createdAt: '2026-11-08T09:30:00.000Z',
  updatedAt: '2026-11-08T09:30:00.000Z',
};

const ERRORS = [HttpStatus.UNAUTHORIZED];
const NOT_VERIFIED = {
  status: HttpStatus.FORBIDDEN,
  description:
    'Not a vendor, 2FA not set up, or the business is not verified (or suspended).',
  message: 'Your business must be verified before you can list products',
};
const NOT_FOUND = { status: HttpStatus.NOT_FOUND, message: 'Product not found' };

@ApiTags('Vendor Products')
@ApiBearerAuth()
@Roles('vendor')
@Controller('vendor/products')
export class VendorProductsController {
  constructor(private readonly products: ProductsService) {}

  @ApiRoute({
    summary: 'My products',
    path: '/api/v1/vendor/products',
    description:
      'Newest first; deleted products are left out. `isPublic` says whether customers can see each one right now.',
    message: 'Products retrieved',
    model: VendorProductDto,
    paginated: true,
    errors: [HttpStatus.BAD_REQUEST, ...ERRORS, NOT_VERIFIED],
  })
  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: VendorProductsQueryDto,
  ): Promise<Page<VendorProductDto>> {
    return this.products.vendorList(user.id, query);
  }

  @ApiRoute({
    summary: 'One of my products',
    path: '/api/v1/vendor/products/{id}',
    message: 'Product retrieved',
    model: VendorProductDto,
    example: PRODUCT_EXAMPLE,
    errors: [...ERRORS, NOT_VERIFIED, NOT_FOUND],
  })
  @Get(':id')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<VendorProductDto> {
    return this.products.vendorGet(user.id, id);
  }

  @ApiRoute({
    summary: 'Create a product',
    path: '/api/v1/vendor/products',
    description: `PRD V7. Verified stores only.

- Price in **US cents** ($12.50 = \`1250\`), paid 1:1 in USDC.
- \`certifications\` must be among the store's verified labels.
- Add photos next with \`POST /vendor/products/{id}/images\`; create as \`hidden\` to finish them first.`,
    message: 'Product created',
    status: HttpStatus.CREATED,
    model: VendorProductDto,
    example: PRODUCT_EXAMPLE,
    errors: [
      {
        status: HttpStatus.BAD_REQUEST,
        description:
          'Validation failed, inactive category, or a certification the store is not verified for.',
        message: 'Your store is not verified for: fsc',
      },
      ...ERRORS,
      NOT_VERIFIED,
    ],
  })
  @ApiBody({
    type: CreateProductDto,
    examples: {
      tote: {
        summary: 'Certified product',
        value: {
          title: 'Organic cotton tote bag',
          description: 'Hand-stitched from GOTS-certified cotton. Holds 15 kg.',
          priceCents: 1250,
          stock: 40,
          categoryId: '0197c2a4-5b1e-7d3a-9c10-6f2e8b4a1d55',
          certifications: ['gots'],
        },
      },
    },
  })
  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateProductDto,
  ): Promise<VendorProductDto> {
    return this.products.create(user, dto);
  }

  @ApiRoute({
    summary: 'Edit, hide or show a product',
    path: '/api/v1/vendor/products/{id}',
    description:
      'Partial update. `status: hidden` takes it off the storefront; `active` brings it back. A product an admin removed cannot be edited.',
    message: 'Product updated',
    model: VendorProductDto,
    example: PRODUCT_EXAMPLE,
    errors: [
      HttpStatus.BAD_REQUEST,
      ...ERRORS,
      NOT_VERIFIED,
      NOT_FOUND,
      {
        status: HttpStatus.CONFLICT,
        message: 'An admin removed this product; it cannot be edited',
      },
    ],
  })
  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
  ): Promise<VendorProductDto> {
    return this.products.update(user, id, dto);
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a product',
    description:
      'Removes it from the store; carts holding it show it as unavailable. Kept internally for order history. 204, no body.',
  })
  @ApiResponse({ status: HttpStatus.NO_CONTENT, description: 'Deleted.' })
  @ApiErrors('/api/v1/vendor/products/{id}', ...ERRORS, HttpStatus.FORBIDDEN, NOT_FOUND)
  @Delete(':id')
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.products.remove(user, id);
  }

  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['image'],
      properties: { image: { type: 'string', format: 'binary' } },
    },
  })
  @UseInterceptors(
    FileInterceptor('image', {
      limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 5 },
    }),
  )
  @ApiRoute({
    summary: 'Add a photo',
    path: '/api/v1/vendor/products/{id}/images',
    description:
      'One `multipart/form-data` part named `image`: JPEG, PNG or WebP, up to 5 MB. Up to 8 photos; new ones go last. The first is the cover.',
    message: 'Photo added',
    status: HttpStatus.CREATED,
    model: VendorProductDto,
    example: PRODUCT_EXAMPLE,
    errors: [
      HttpStatus.BAD_REQUEST,
      ...ERRORS,
      NOT_VERIFIED,
      NOT_FOUND,
      { status: HttpStatus.CONFLICT, message: 'At most 8 photos per product' },
      HttpStatus.PAYLOAD_TOO_LARGE,
      {
        status: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        message: 'The product photo must be a JPEG, PNG or WebP image',
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    ],
  })
  @Post(':id/images')
  addImage(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: UploadedImage | undefined,
  ): Promise<VendorProductDto> {
    return this.products.addImage(user, id, file);
  }

  @ApiRoute({
    summary: 'Reorder photos',
    path: '/api/v1/vendor/products/{id}/images/order',
    description: 'Send every image id in the new order; the first becomes the cover.',
    message: 'Photos reordered',
    model: VendorProductDto,
    example: PRODUCT_EXAMPLE,
    errors: [HttpStatus.BAD_REQUEST, ...ERRORS, NOT_VERIFIED, NOT_FOUND],
  })
  @Put(':id/images/order')
  reorder(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ImageOrderDto,
  ): Promise<VendorProductDto> {
    return this.products.reorderImages(user, id, dto.imageIds);
  }

  @ApiRoute({
    summary: 'Delete a photo',
    path: '/api/v1/vendor/products/{id}/images/{imageId}',
    message: 'Photo deleted',
    model: VendorProductDto,
    example: PRODUCT_EXAMPLE,
    errors: [
      ...ERRORS,
      NOT_VERIFIED,
      NOT_FOUND,
      { status: HttpStatus.NOT_FOUND, message: 'Image not found' },
    ],
  })
  @Delete(':id/images/:imageId')
  removeImage(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('imageId', ParseUUIDPipe) imageId: string,
  ): Promise<VendorProductDto> {
    return this.products.removeImage(user, id, imageId);
  }
}
