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
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, Public } from '../auth/decorators.js';
import { Roles } from '../authorization/roles.decorator.js';
import { ApiRoute } from '../common/api-docs.js';
import { type Page, PaginationQueryDto } from '../common/pagination.js';
import { STAFF_ROLES } from '../database/schema/index.js';
import {
  AdminReviewDto,
  AdminReviewsQueryDto,
  CreateReviewDto,
  HideReviewDto,
  MyReviewDto,
  PendingReviewDto,
  ProductReviewsQueryDto,
  RatingSummaryDto,
  ReviewDto,
  UpdateReviewDto,
  VendorReviewsQueryDto,
} from './dto/reviews.dto.js';
import { ReviewsService } from './reviews.service.js';

const REVIEW_EXAMPLE = {
  id: '0197c2c3-1111-7a2b-b3c4-1d2e3f4a5b6c',
  rating: 5,
  title: 'Sturdy and beautiful',
  body: 'Carries all my groceries and still looks new after a month.',
  author: 'Grace A.',
  verifiedPurchase: true,
  product: {
    id: '0197c2b0-1111-7a2b-b3c4-1d2e3f4a5b6c',
    title: 'Organic cotton tote bag',
    slug: 'organic-cotton-tote-bag-k3x9qa',
  },
  createdAt: '2026-11-10T09:30:00.000Z',
  updatedAt: '2026-11-10T09:30:00.000Z',
};
const MY_EXAMPLE = {
  ...REVIEW_EXAMPLE,
  status: 'visible',
  moderationReason: null,
  orderLineId: '0197c2b5-1111-7a2b-b3c4-1d2e3f4a5b6c',
};
const PRODUCT_NOT_FOUND = { status: HttpStatus.NOT_FOUND, message: 'Product not found' };
const REVIEW_NOT_FOUND = { status: HttpStatus.NOT_FOUND, message: 'Review not found' };
const CUSTOMER_ERRORS = [
  HttpStatus.UNAUTHORIZED,
  { status: HttpStatus.FORBIDDEN, description: 'Only customer accounts.' },
];

@ApiTags('Reviews')
@Controller()
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Public()
  @ApiRoute({
    summary: 'Reviews of a product',
    path: '/api/v1/products/{slug}/reviews',
    description: 'Public. Verified purchases only; filter by stars, sort by newest, highest or lowest.',
    message: 'Reviews retrieved',
    model: ReviewDto,
    paginated: true,
    errors: [HttpStatus.BAD_REQUEST, PRODUCT_NOT_FOUND],
  })
  @Get('products/:slug/reviews')
  forProduct(@Param('slug') slug: string, @Query() q: ProductReviewsQueryDto): Promise<Page<ReviewDto>> {
    return this.reviews.forProduct(slug, q);
  }

  @Public()
  @ApiRoute({
    summary: 'Rating summary of a product',
    path: '/api/v1/products/{slug}/reviews/summary',
    description: 'Average, count and the star bars. The product page also carries `rating`.',
    message: 'Rating summary retrieved',
    model: RatingSummaryDto,
    example: { average: 4.6, count: 23, distribution: { '1': 0, '2': 1, '3': 1, '4': 5, '5': 16 } },
    errors: [PRODUCT_NOT_FOUND],
  })
  @Get('products/:slug/reviews/summary')
  summary(@Param('slug') slug: string): Promise<RatingSummaryDto> {
    return this.reviews.summary(slug);
  }

  @ApiBearerAuth()
  @Roles('customer')
  @ApiRoute({
    summary: 'Items waiting for my review',
    path: '/api/v1/reviews/pending',
    description: 'Delivered order items not reviewed yet ("Rate your purchase").',
    message: 'Pending reviews retrieved',
    model: PendingReviewDto,
    paginated: true,
    errors: CUSTOMER_ERRORS,
  })
  @Get('reviews/pending')
  pending(@CurrentUser() user: AuthUser, @Query() q: PaginationQueryDto): Promise<Page<PendingReviewDto>> {
    return this.reviews.pending(user.id, q);
  }

  @ApiBearerAuth()
  @Roles('customer')
  @ApiRoute({
    summary: 'My reviews',
    path: '/api/v1/reviews',
    description: 'Including hidden ones, with the reason.',
    message: 'Reviews retrieved',
    model: MyReviewDto,
    paginated: true,
    errors: CUSTOMER_ERRORS,
  })
  @Get('reviews')
  mine(@CurrentUser() user: AuthUser, @Query() q: PaginationQueryDto): Promise<Page<MyReviewDto>> {
    return this.reviews.mine(user.id, q);
  }

  @ApiBearerAuth()
  @Roles('customer')
  @ApiRoute({
    summary: 'Write a review',
    path: '/api/v1/reviews',
    description: 'One per order item, once it is delivered. The vendor is told in their inbox.',
    message: 'Thanks for your review',
    status: HttpStatus.CREATED,
    model: MyReviewDto,
    example: MY_EXAMPLE,
    errors: [
      HttpStatus.BAD_REQUEST,
      ...CUSTOMER_ERRORS,
      { status: HttpStatus.NOT_FOUND, message: 'Order item not found' },
      { status: HttpStatus.CONFLICT, message: 'You already reviewed this item. Edit your review instead' },
    ],
  })
  @Post('reviews')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateReviewDto): Promise<MyReviewDto> {
    return this.reviews.create(user, dto);
  }

  @ApiBearerAuth()
  @Roles('customer')
  @ApiRoute({
    summary: 'Edit my review',
    path: '/api/v1/reviews/{id}',
    message: 'Review updated',
    model: MyReviewDto,
    example: MY_EXAMPLE,
    errors: [HttpStatus.BAD_REQUEST, ...CUSTOMER_ERRORS, REVIEW_NOT_FOUND],
  })
  @Patch('reviews/:id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateReviewDto,
  ): Promise<MyReviewDto> {
    return this.reviews.update(user, id, dto);
  }

  @ApiBearerAuth()
  @Roles('customer')
  @ApiRoute({
    summary: 'Delete my review',
    path: '/api/v1/reviews/{id}',
    description: 'The item shows in pending reviews again.',
    message: 'Review deleted',
    errors: [...CUSTOMER_ERRORS, REVIEW_NOT_FOUND],
  })
  @Delete('reviews/:id')
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<null> {
    await this.reviews.remove(user, id);
    return null;
  }

  @ApiBearerAuth()
  @Roles('vendor')
  @ApiRoute({
    summary: 'Reviews of my products',
    path: '/api/v1/vendor/reviews',
    message: 'Reviews retrieved',
    model: ReviewDto,
    paginated: true,
    errors: [HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN],
  })
  @Get('vendor/reviews')
  forVendor(@CurrentUser() user: AuthUser, @Query() q: VendorReviewsQueryDto): Promise<Page<ReviewDto>> {
    return this.reviews.forVendor(user.id, q);
  }
}

@ApiTags('Admin Reviews')
@ApiBearerAuth()
@Roles(...STAFF_ROLES)
@Controller('admin/reviews')
export class AdminReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @ApiRoute({
    summary: 'All reviews',
    path: '/api/v1/admin/reviews',
    message: 'Reviews retrieved',
    model: AdminReviewDto,
    paginated: true,
    errors: [HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN],
  })
  @Get()
  list(@Query() q: AdminReviewsQueryDto): Promise<Page<AdminReviewDto>> {
    return this.reviews.adminList(q);
  }

  @HttpCode(HttpStatus.OK)
  @ApiRoute({
    summary: 'Hide a review',
    path: '/api/v1/admin/reviews/{id}/hide',
    description: 'Takes it off the product page; the author sees the reason. Audited.',
    message: 'Review hidden',
    model: AdminReviewDto,
    errors: [HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN, REVIEW_NOT_FOUND],
  })
  @Post(':id/hide')
  hide(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: HideReviewDto,
  ): Promise<AdminReviewDto> {
    return this.reviews.moderate(admin, id, true, dto.reason);
  }

  @HttpCode(HttpStatus.OK)
  @ApiRoute({
    summary: 'Unhide a review',
    path: '/api/v1/admin/reviews/{id}/unhide',
    message: 'Review visible again',
    model: AdminReviewDto,
    errors: [HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN, REVIEW_NOT_FOUND, HttpStatus.CONFLICT],
  })
  @Post(':id/unhide')
  unhide(@CurrentUser() admin: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<AdminReviewDto> {
    return this.reviews.moderate(admin, id, false, null);
  }
}
