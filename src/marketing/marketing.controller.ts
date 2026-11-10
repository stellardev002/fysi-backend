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
import { CurrentUser, OptionalAuth, OptionalUser, Public } from '../auth/decorators.js';
import { Roles } from '../authorization/roles.decorator.js';
import { ApiRoute } from '../common/api-docs.js';
import type { Page } from '../common/pagination.js';
import { STAFF_ROLES } from '../database/schema/index.js';
import { RateLimit } from '../rate-limit/rate-limit.decorator.js';
import {
  CampaignDto,
  CampaignsQueryDto,
  CreateCampaignDto,
  NewsletterPreferenceDto,
  NewsletterStatusDto,
  SendCampaignDto,
  SubscribeDto,
  SubscriberDto,
  SubscribersQueryDto,
  TestCampaignDto,
  UnsubscribeDto,
  UpdateCampaignDto,
} from './dto/marketing.dto.js';
import { MarketingService } from './marketing.service.js';

const CAMPAIGN_EXAMPLE = {
  id: '0197c2c5-1111-7a2b-b3c4-1d2e3f4a5b6c',
  name: 'Black Friday 2026',
  subject: 'Up to 30% off certified eco products',
  preheader: 'This weekend only, from verified Nigerian vendors.',
  heading: 'Black Friday on Fysi',
  body: 'Our vendors are taking up to 30% off.\n\nEvery product is verified eco-friendly, paid in USDC.',
  ctaLabel: 'Shop the sale',
  ctaUrl: 'https://fysi.ng/sale',
  audience: 'newsletter',
  status: 'draft',
  recipientCount: 1240,
  sentCount: 0,
  failedCount: 0,
  scheduledAt: null,
  sentAt: null,
  createdBy: '0197c2a4-8f10-7a2b-b3c4-1d2e3f4a5b6c',
  createdAt: '2026-11-10T09:30:00.000Z',
  updatedAt: '2026-11-10T09:30:00.000Z',
};
const ADMIN_ERRORS = [HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN];
const NOT_FOUND = { status: HttpStatus.NOT_FOUND, message: 'Campaign not found' };

@ApiTags('Newsletter')
@Controller('newsletter')
export class NewsletterController {
  constructor(private readonly marketing: MarketingService) {}

  @OptionalAuth()
  @RateLimit({ capacity: 5, refillPerSec: 1 / 60 })
  @HttpCode(HttpStatus.OK)
  @ApiRoute({
    summary: 'Subscribe',
    path: '/api/v1/newsletter/subscribe',
    optionalAuth: true,
    description:
      'The footer / popup form. Same answer whether the address is new or already subscribed; a new subscriber gets a welcome email with an unsubscribe link.',
    message: 'Thanks for subscribing',
    model: NewsletterStatusDto,
    example: { email: 'grace@example.com', subscribed: true },
    errors: [HttpStatus.BAD_REQUEST, HttpStatus.TOO_MANY_REQUESTS],
  })
  @Post('subscribe')
  subscribe(@OptionalUser() user: AuthUser | undefined, @Body() dto: SubscribeDto): Promise<NewsletterStatusDto> {
    return this.marketing.subscribe(dto.email, dto.source ?? null, user?.id);
  }

  @Public()
  @RateLimit({ capacity: 10, refillPerSec: 1 / 6 })
  @HttpCode(HttpStatus.OK)
  @ApiRoute({
    summary: 'Unsubscribe',
    path: '/api/v1/newsletter/unsubscribe',
    description:
      'The unsubscribe page posts `email` and `token` from the link (`/unsubscribe?email=…&token=…`) in every newsletter and campaign. Also stops campaigns to the account with that address. No sign-in needed.',
    message: 'You are unsubscribed',
    model: NewsletterStatusDto,
    example: { email: 'grace@example.com', subscribed: false },
    errors: [
      { status: HttpStatus.BAD_REQUEST, message: 'This unsubscribe link is not valid' },
      HttpStatus.TOO_MANY_REQUESTS,
    ],
  })
  @Post('unsubscribe')
  unsubscribe(@Body() dto: UnsubscribeDto): Promise<NewsletterStatusDto> {
    return this.marketing.unsubscribe(dto.email, dto.token);
  }

  @ApiBearerAuth()
  @Roles('customer', 'vendor')
  @ApiRoute({
    summary: 'My newsletter setting',
    path: '/api/v1/newsletter/me',
    message: 'Newsletter setting retrieved',
    model: NewsletterStatusDto,
    example: { email: 'grace@example.com', subscribed: true },
    errors: [HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN],
  })
  @Get('me')
  me(@CurrentUser() user: AuthUser): Promise<NewsletterStatusDto> {
    return this.marketing.preference(user.id);
  }

  @ApiBearerAuth()
  @Roles('customer', 'vendor')
  @ApiRoute({
    summary: 'Change my newsletter setting',
    path: '/api/v1/newsletter/me',
    description: '`false` also stops Fysi campaigns to this account.',
    message: 'Newsletter setting saved',
    model: NewsletterStatusDto,
    example: { email: 'grace@example.com', subscribed: false },
    errors: [HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN],
  })
  @Put('me')
  setMe(@CurrentUser() user: AuthUser, @Body() dto: NewsletterPreferenceDto): Promise<NewsletterStatusDto> {
    return this.marketing.setPreference(user.id, dto.subscribed);
  }
}

@ApiTags('Admin Campaigns')
@ApiBearerAuth()
@Roles(...STAFF_ROLES)
@Controller('admin')
export class AdminMarketingController {
  constructor(private readonly marketing: MarketingService) {}

  @ApiRoute({
    summary: 'Newsletter subscribers',
    path: '/api/v1/admin/newsletter/subscribers',
    description: 'CSV: `GET /admin/exports/newsletter.csv`.',
    message: 'Subscribers retrieved',
    model: SubscriberDto,
    paginated: true,
    errors: [HttpStatus.BAD_REQUEST, ...ADMIN_ERRORS],
  })
  @Get('newsletter/subscribers')
  subscribers(@Query() q: SubscribersQueryDto): Promise<Page<SubscriberDto>> {
    return this.marketing.subscribers(q);
  }

  @ApiRoute({
    summary: 'Campaigns',
    path: '/api/v1/admin/campaigns',
    message: 'Campaigns retrieved',
    model: CampaignDto,
    paginated: true,
    errors: [HttpStatus.BAD_REQUEST, ...ADMIN_ERRORS],
  })
  @Get('campaigns')
  list(@Query() q: CampaignsQueryDto): Promise<Page<CampaignDto>> {
    return this.marketing.list(q);
  }

  @ApiRoute({
    summary: 'One campaign',
    path: '/api/v1/admin/campaigns/{id}',
    description: 'For a draft, `recipientCount` is who would get it if sent now.',
    message: 'Campaign retrieved',
    model: CampaignDto,
    example: CAMPAIGN_EXAMPLE,
    errors: [...ADMIN_ERRORS, NOT_FOUND],
  })
  @Get('campaigns/:id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<CampaignDto> {
    return this.marketing.get(id);
  }

  @ApiRoute({
    summary: 'Create a campaign',
    path: '/api/v1/admin/campaigns',
    description: `An email in the Fysi template (logo, brand colours, one button). Starts as a draft: send yourself a test, then send or schedule it.

Every email carries an unsubscribe link; people who unsubscribed never get campaigns.`,
    message: 'Campaign created',
    status: HttpStatus.CREATED,
    model: CampaignDto,
    example: CAMPAIGN_EXAMPLE,
    errors: [HttpStatus.BAD_REQUEST, ...ADMIN_ERRORS],
  })
  @Post('campaigns')
  create(@CurrentUser() admin: AuthUser, @Body() dto: CreateCampaignDto): Promise<CampaignDto> {
    return this.marketing.create(admin, dto);
  }

  @ApiRoute({
    summary: 'Edit a campaign',
    path: '/api/v1/admin/campaigns/{id}',
    description: 'While a draft or scheduled.',
    message: 'Campaign updated',
    model: CampaignDto,
    example: CAMPAIGN_EXAMPLE,
    errors: [HttpStatus.BAD_REQUEST, ...ADMIN_ERRORS, NOT_FOUND, HttpStatus.CONFLICT],
  })
  @Patch('campaigns/:id')
  update(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCampaignDto,
  ): Promise<CampaignDto> {
    return this.marketing.update(admin, id, dto);
  }

  @ApiRoute({
    summary: 'Delete a draft',
    path: '/api/v1/admin/campaigns/{id}',
    message: 'Campaign deleted',
    errors: [...ADMIN_ERRORS, NOT_FOUND, HttpStatus.CONFLICT],
  })
  @Delete('campaigns/:id')
  async remove(@CurrentUser() admin: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<null> {
    await this.marketing.remove(admin, id);
    return null;
  }

  @HttpCode(HttpStatus.OK)
  @RateLimit({ capacity: 10, refillPerSec: 1 / 30 })
  @ApiRoute({
    summary: 'Send a test',
    path: '/api/v1/admin/campaigns/{id}/test',
    description: 'One copy, subject prefixed `[Test]`, to you or the address given.',
    message: 'Test email sent',
    example: { sentTo: 'ada@fysi.ng' },
    errors: [HttpStatus.BAD_REQUEST, ...ADMIN_ERRORS, NOT_FOUND, HttpStatus.TOO_MANY_REQUESTS],
  })
  @Post('campaigns/:id/test')
  test(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TestCampaignDto,
  ): Promise<{ sentTo: string }> {
    return this.marketing.test(admin, id, dto.email);
  }

  @HttpCode(HttpStatus.OK)
  @ApiRoute({
    summary: 'Send or schedule',
    path: '/api/v1/admin/campaigns/{id}/send',
    description:
      'Now, or at `scheduledAt`. Recipients are fixed when sending starts; emails go out in batches of 100 per sweep, and `sentCount` / `failedCount` show progress. Audited.',
    message: 'Campaign scheduled',
    model: CampaignDto,
    example: { ...CAMPAIGN_EXAMPLE, status: 'scheduled', scheduledAt: '2026-11-27T07:00:00.000Z' },
    errors: [
      HttpStatus.BAD_REQUEST,
      ...ADMIN_ERRORS,
      NOT_FOUND,
      { status: HttpStatus.CONFLICT, message: 'Nobody is in this audience yet' },
    ],
  })
  @Post('campaigns/:id/send')
  send(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendCampaignDto,
  ): Promise<CampaignDto> {
    return this.marketing.send(admin, id, dto.scheduledAt);
  }

  @HttpCode(HttpStatus.OK)
  @ApiRoute({
    summary: 'Cancel a scheduled campaign',
    path: '/api/v1/admin/campaigns/{id}/cancel',
    message: 'Campaign cancelled',
    model: CampaignDto,
    example: { ...CAMPAIGN_EXAMPLE, status: 'cancelled' },
    errors: [...ADMIN_ERRORS, NOT_FOUND, HttpStatus.CONFLICT],
  })
  @Post('campaigns/:id/cancel')
  cancel(@CurrentUser() admin: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<CampaignDto> {
    return this.marketing.cancel(admin, id);
  }
}
