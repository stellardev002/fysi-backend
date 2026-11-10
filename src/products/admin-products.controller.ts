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
  Delete,
  Patch,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { MAX_IMAGE_BYTES, type UploadedImage } from '../storage/images.js';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser } from '../auth/decorators.js';
import { Roles } from '../authorization/roles.decorator.js';
import { ApiRoute } from '../common/api-docs.js';
import type { Page } from '../common/pagination.js';
import { STAFF_ROLES } from '../database/schema/index.js';
import {
  AdminCreateProductDto,
  AdminProductDto,
  UpdateProductDto,
  AdminProductsQueryDto,
  ModerationReasonDto,
} from './dto/products.dto.js';
import { ProductsService } from './products.service.js';
import { PRODUCT_EXAMPLE } from './vendor-products.controller.js';

const ADMIN_EXAMPLE = {
  ...PRODUCT_EXAMPLE,
  vendorId: '0197c2a4-8f10-7a2b-b3c4-1d2e3f4a5b6c',
  vendorName: 'EcoThreads Lagos',
  vendorSlug: 'ecothreads-lagos',
  deletedAt: null,
};
const ERRORS = [HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN];
const NOT_FOUND = { status: HttpStatus.NOT_FOUND, message: 'Product not found' };
const FINAL = {
  status: HttpStatus.CONFLICT,
  message: 'This product was removed; that is final',
  description: 'Already removed.',
};

@ApiTags('Admin Catalogue')
@ApiBearerAuth()
@Roles(...STAFF_ROLES)
@Controller('admin')
export class AdminProductsController {
  constructor(private readonly products: ProductsService) {}

  @ApiRoute({
    summary: 'All products',
    path: '/api/v1/admin/products',
    description:
      'Every product with its moderation state and whether customers can see it (`isPublic`). Filter by store, moderation status or text.',
    message: 'Products retrieved',
    model: AdminProductDto,
    paginated: true,
    errors: [HttpStatus.BAD_REQUEST, ...ERRORS],
  })
  @Get('products')
  list(@Query() query: AdminProductsQueryDto): Promise<Page<AdminProductDto>> {
    return this.products.adminList(query);
  }

  @HttpCode(HttpStatus.OK)
  @ApiRoute({
    summary: 'Hide a product',
    path: '/api/v1/admin/products/{id}/hide',
    description:
      'PRD A5. Takes the product off the storefront until an admin unhides it. The vendor sees the reason.',
    message: 'Product hidden',
    model: AdminProductDto,
    example: {
      ...ADMIN_EXAMPLE,
      moderationStatus: 'hidden',
      moderationReason: 'Photos show a different product.',
      isPublic: false,
    },
    errors: [HttpStatus.BAD_REQUEST, ...ERRORS, NOT_FOUND, FINAL],
  })
  @Post('products/:id/hide')
  hide(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ModerationReasonDto,
  ): Promise<AdminProductDto> {
    return this.products.moderate(admin, id, 'hide', dto.reason);
  }

  @HttpCode(HttpStatus.OK)
  @ApiRoute({
    summary: 'Unhide a product',
    path: '/api/v1/admin/products/{id}/unhide',
    message: 'Product visible again',
    model: AdminProductDto,
    example: ADMIN_EXAMPLE,
    errors: [
      ...ERRORS,
      NOT_FOUND,
      { status: HttpStatus.CONFLICT, message: 'This product is not hidden' },
    ],
  })
  @Post('products/:id/unhide')
  unhide(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AdminProductDto> {
    return this.products.moderate(admin, id, 'unhide', null);
  }

  @HttpCode(HttpStatus.OK)
  @ApiRoute({
    summary: 'Remove a product',
    path: '/api/v1/admin/products/{id}/remove',
    description:
      'PRD A5. Permanently off the storefront; the vendor can no longer edit it. Use for listings that break the rules.',
    message: 'Product removed',
    model: AdminProductDto,
    example: {
      ...ADMIN_EXAMPLE,
      moderationStatus: 'removed',
      moderationReason: 'Not an eco-friendly product.',
      isPublic: false,
    },
    errors: [HttpStatus.BAD_REQUEST, ...ERRORS, NOT_FOUND, FINAL],
  })
  @Post('products/:id/remove')
  remove(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ModerationReasonDto,
  ): Promise<AdminProductDto> {
    return this.products.moderate(admin, id, 'remove', dto.reason);
  }

  @ApiRoute({
    summary: 'Add a product for a vendor',
    path: '/api/v1/admin/products',
    description:
      'Lists a product under a verified store, e.g. while onboarding a vendor. Same rules as the vendor form (active category, the store’s verified certifications only). The vendor sees and manages it like their own; the audit log records the admin. Add photos with `POST /admin/products/{id}/images`.',
    message: 'Product created',
    status: HttpStatus.CREATED,
    model: AdminProductDto,
    example: ADMIN_EXAMPLE,
    errors: [
      HttpStatus.BAD_REQUEST,
      ...ERRORS,
      { status: HttpStatus.NOT_FOUND, message: 'Vendor profile not found' },
    ],
  })
  @Post('products')
  async create(@CurrentUser() admin: AuthUser, @Body() dto: AdminCreateProductDto): Promise<AdminProductDto> {
    const { vendorId, ...product } = dto;
    const created = await this.products.create(admin, product, vendorId);
    return this.products.adminGet(created.id);
  }

  @ApiRoute({
    summary: 'Edit a product',
    path: '/api/v1/admin/products/{id}',
    description: 'Partial update on behalf of the vendor (e.g. fixing a title or price). Audited as the admin.',
    message: 'Product updated',
    model: AdminProductDto,
    example: ADMIN_EXAMPLE,
    errors: [HttpStatus.BAD_REQUEST, ...ERRORS, NOT_FOUND, HttpStatus.CONFLICT],
  })
  @Patch('products/:id')
  async update(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
  ): Promise<AdminProductDto> {
    await this.products.update(admin, id, dto, await this.products.vendorOf(id));
    return this.products.adminGet(id);
  }

  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['image'],
      properties: { image: { type: 'string', format: 'binary' } },
    },
  })
  @UseInterceptors(FileInterceptor('image', { limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 5 } }))
  @ApiRoute({
    summary: 'Add a photo',
    path: '/api/v1/admin/products/{id}/images',
    description: 'One `multipart/form-data` part named `image`: JPEG, PNG or WebP, up to 5 MB. At most 8 per product.',
    message: 'Photo added',
    status: HttpStatus.CREATED,
    model: AdminProductDto,
    example: ADMIN_EXAMPLE,
    errors: [
      HttpStatus.BAD_REQUEST,
      ...ERRORS,
      NOT_FOUND,
      { status: HttpStatus.CONFLICT, message: 'At most 8 photos per product' },
      HttpStatus.PAYLOAD_TOO_LARGE,
      HttpStatus.SERVICE_UNAVAILABLE,
    ],
  })
  @Post('products/:id/images')
  async addImage(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: UploadedImage | undefined,
  ): Promise<AdminProductDto> {
    await this.products.addImage(admin, id, file, await this.products.vendorOf(id));
    return this.products.adminGet(id);
  }

  @ApiRoute({
    summary: 'Delete a photo',
    path: '/api/v1/admin/products/{id}/images/{imageId}',
    message: 'Photo deleted',
    model: AdminProductDto,
    example: ADMIN_EXAMPLE,
    errors: [...ERRORS, NOT_FOUND, { status: HttpStatus.NOT_FOUND, message: 'Image not found' }],
  })
  @Delete('products/:id/images/:imageId')
  async removeImage(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('imageId', ParseUUIDPipe) imageId: string,
  ): Promise<AdminProductDto> {
    await this.products.removeImage(admin, id, imageId, await this.products.vendorOf(id));
    return this.products.adminGet(id);
  }
}
