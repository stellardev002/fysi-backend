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
import { CurrentUser } from '../auth/decorators.js';
import { Roles } from '../authorization/roles.decorator.js';
import { ApiRoute } from '../common/api-docs.js';
import type { Page } from '../common/pagination.js';
import {
  CreatePromotionDto,
  PromotionDto,
  PromotionsQueryDto,
  UpdatePromotionDto,
} from './dto/promotions.dto.js';
import { PromotionsService } from './promotions.service.js';

const EXAMPLE = {
  id: '0197c2c2-1111-7a2b-b3c4-1d2e3f4a5b6c',
  name: 'Black Friday',
  discountPercent: 15,
  appliesToAll: false,
  products: [
    {
      id: '0197c2b0-1111-7a2b-b3c4-1d2e3f4a5b6c',
      title: 'Organic cotton tote bag',
      slug: 'organic-cotton-tote-bag-k3x9qa',
      price: { cents: 1250, usd: '12.50' },
      salePrice: { cents: 1062, usd: '10.62' },
    },
  ],
  startsAt: '2026-11-27T00:00:00.000Z',
  endsAt: '2026-11-30T23:59:59.000Z',
  state: 'scheduled',
  stats: { orders: 0, unitsSold: 0, revenue: { cents: 0, usd: '0.00' }, discountGiven: { cents: 0, usd: '0.00' } },
  createdAt: '2026-11-10T09:30:00.000Z',
};
const ERRORS = [
  HttpStatus.UNAUTHORIZED,
  { status: HttpStatus.FORBIDDEN, description: 'Not a vendor, or the store is not verified and active.' },
];
const NOT_FOUND = { status: HttpStatus.NOT_FOUND, message: 'Promotion not found' };

@ApiTags('Vendor Promotions')
@ApiBearerAuth()
@Roles('vendor')
@Controller('vendor/promotions')
export class PromotionsController {
  constructor(private readonly promotions: PromotionsService) {}

  @ApiRoute({
    summary: 'My promotions',
    path: '/api/v1/vendor/promotions',
    description: 'Newest start date first, with sales made at the promotional price.',
    message: 'Promotions retrieved',
    model: PromotionDto,
    paginated: true,
    errors: [HttpStatus.BAD_REQUEST, ...ERRORS],
  })
  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: PromotionsQueryDto): Promise<Page<PromotionDto>> {
    return this.promotions.list(user.id, q);
  }

  @ApiRoute({
    summary: 'One promotion',
    path: '/api/v1/vendor/promotions/{id}',
    message: 'Promotion retrieved',
    model: PromotionDto,
    example: EXAMPLE,
    errors: [...ERRORS, NOT_FOUND],
  })
  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<PromotionDto> {
    return this.promotions.get(user.id, id);
  }

  @ApiRoute({
    summary: 'Create a promotion',
    path: '/api/v1/vendor/promotions',
    description: `A percentage off chosen products, or the whole store, between two dates. No code: prices drop on the storefront, in carts and at checkout while it runs.

- 1–90% off, up to 180 days, at most 20 open promotions.
- When several cover a product, the biggest discount wins; they never stack.
- Orders keep the price they were paid at, and commission is on the sale price.`,
    message: 'Promotion created',
    status: HttpStatus.CREATED,
    model: PromotionDto,
    example: EXAMPLE,
    errors: [
      { status: HttpStatus.BAD_REQUEST, message: 'endsAt must be after startsAt' },
      ...ERRORS,
      { status: HttpStatus.CONFLICT, message: 'A store can have at most 20 promotions at a time' },
    ],
  })
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreatePromotionDto): Promise<PromotionDto> {
    return this.promotions.create(user.id, dto);
  }

  @ApiRoute({
    summary: 'Edit a promotion',
    path: '/api/v1/vendor/promotions/{id}',
    description: 'Before it ends. A running promotion keeps its start date. `productIds` replaces the list.',
    message: 'Promotion updated',
    model: PromotionDto,
    example: EXAMPLE,
    errors: [HttpStatus.BAD_REQUEST, ...ERRORS, NOT_FOUND, HttpStatus.CONFLICT],
  })
  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePromotionDto,
  ): Promise<PromotionDto> {
    return this.promotions.update(user.id, id, dto);
  }

  @HttpCode(HttpStatus.OK)
  @ApiRoute({
    summary: 'Pause',
    path: '/api/v1/vendor/promotions/{id}/pause',
    description: 'Prices go back until resumed.',
    message: 'Promotion paused',
    model: PromotionDto,
    example: { ...EXAMPLE, state: 'paused' },
    errors: [...ERRORS, NOT_FOUND, HttpStatus.CONFLICT],
  })
  @Post(':id/pause')
  pause(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<PromotionDto> {
    return this.promotions.setStatus(user.id, id, 'pause');
  }

  @HttpCode(HttpStatus.OK)
  @ApiRoute({
    summary: 'Resume',
    path: '/api/v1/vendor/promotions/{id}/resume',
    message: 'Promotion resumed',
    model: PromotionDto,
    example: { ...EXAMPLE, state: 'running' },
    errors: [...ERRORS, NOT_FOUND, HttpStatus.CONFLICT],
  })
  @Post(':id/resume')
  resume(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<PromotionDto> {
    return this.promotions.setStatus(user.id, id, 'resume');
  }

  @HttpCode(HttpStatus.OK)
  @ApiRoute({
    summary: 'End now',
    path: '/api/v1/vendor/promotions/{id}/end',
    description: 'Final. Prices go back at once; sales already made keep their price.',
    message: 'Promotion ended',
    model: PromotionDto,
    example: { ...EXAMPLE, state: 'ended' },
    errors: [...ERRORS, NOT_FOUND, HttpStatus.CONFLICT],
  })
  @Post(':id/end')
  end(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<PromotionDto> {
    return this.promotions.setStatus(user.id, id, 'end');
  }
}
