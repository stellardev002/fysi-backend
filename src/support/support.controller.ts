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
import { CurrentUser, OptionalAuth, OptionalUser } from '../auth/decorators.js';
import { Roles } from '../authorization/roles.decorator.js';
import { ApiRoute } from '../common/api-docs.js';
import type { Page } from '../common/pagination.js';
import { STAFF_ROLES } from '../database/schema/index.js';
import { RateLimit } from '../rate-limit/rate-limit.decorator.js';
import {
  AdminTicketDetailDto,
  AdminTicketsQueryDto,
  AdminTicketSummaryDto,
  CreateTicketDto,
  MyTicketsQueryDto,
  StaffReplyDto,
  TicketDetailDto,
  TicketReplyDto,
  TicketSummaryDto,
  UpdateTicketDto,
} from './dto/support.dto.js';
import { SupportService } from './support.service.js';

const TICKET_EXAMPLE = {
  id: '0197c2c4-1111-7a2b-b3c4-1d2e3f4a5b6c',
  number: 'TK7K3M9QXW',
  category: 'delivery',
  subject: 'My parcel has not arrived',
  status: 'open',
  priority: 'normal',
  orderNumber: 'FYK3M9QXWA',
  vendorOrderId: null,
  productId: null,
  lastMessageAt: '2026-11-10T09:30:00.000Z',
  createdAt: '2026-11-10T09:30:00.000Z',
  messages: [
    {
      id: '0197c2c4-2222-7a2b-b3c4-1d2e3f4a5b6c',
      authorType: 'requester',
      authorName: 'Grace Ajayi',
      body: 'The vendor marked it shipped 9 days ago and the tracking number does not work.',
      createdAt: '2026-11-10T09:30:00.000Z',
    },
  ],
  canReply: true,
};
const ADMIN_EXAMPLE = {
  ...TICKET_EXAMPLE,
  name: 'Grace Ajayi',
  email: 'grace@example.com',
  userId: '0197c2a4-8f10-7a2b-b3c4-1d2e3f4a5b6c',
  userRole: 'customer',
  assignedTo: null,
  assignedToName: null,
  messageCount: 1,
  resolvedAt: null,
};
const NOT_FOUND = { status: HttpStatus.NOT_FOUND, message: 'Request not found' };
const REQUESTER_ERRORS = [
  HttpStatus.UNAUTHORIZED,
  { status: HttpStatus.FORBIDDEN, description: 'Customer and vendor accounts only.' },
];
const ADMIN_ERRORS = [HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN];

@ApiTags('Help & Support')
@Controller('support/tickets')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @OptionalAuth()
  @RateLimit({ capacity: 5, refillPerSec: 1 / 120 })
  @ApiRoute({
    summary: 'Report a problem / contact support',
    path: '/api/v1/support/tickets',
    optionalAuth: true,
    description: `The Report a Problem form. Signed in, the request is tied to the account and an \`orderNumber\` of yours is linked; as a guest, send \`name\` and \`email\`.

Fysi emails a confirmation with the request number, and every reply. For a problem with a delivered order that should hold the vendor's payment, use \`POST /orders/{id}/vendor-orders/{vendorOrderId}/problem\`: it opens a request too.`,
    message: 'Request received. We will reply by email',
    status: HttpStatus.CREATED,
    model: TicketDetailDto,
    example: TICKET_EXAMPLE,
    errors: [
      {
        status: HttpStatus.BAD_REQUEST,
        message: 'Add your name and email so we can reply',
        description: 'Validation failed, a guest without name and email, or an order that is not yours.',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    ],
  })
  @Post()
  create(@OptionalUser() user: AuthUser | undefined, @Body() dto: CreateTicketDto): Promise<TicketDetailDto> {
    return this.support.create(user, dto);
  }

  @ApiBearerAuth()
  @Roles('customer', 'vendor')
  @ApiRoute({
    summary: 'My requests',
    path: '/api/v1/support/tickets',
    description: 'Latest activity first.',
    message: 'Requests retrieved',
    model: TicketSummaryDto,
    paginated: true,
    errors: REQUESTER_ERRORS,
  })
  @Get()
  mine(@CurrentUser() user: AuthUser, @Query() q: MyTicketsQueryDto): Promise<Page<TicketSummaryDto>> {
    return this.support.mine(user.id, q);
  }

  @ApiBearerAuth()
  @Roles('customer', 'vendor')
  @ApiRoute({
    summary: 'One request with its messages',
    path: '/api/v1/support/tickets/{id}',
    message: 'Request retrieved',
    model: TicketDetailDto,
    example: TICKET_EXAMPLE,
    errors: [...REQUESTER_ERRORS, NOT_FOUND],
  })
  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<TicketDetailDto> {
    return this.support.detail(id, user.id);
  }

  @ApiBearerAuth()
  @Roles('customer', 'vendor')
  @ApiRoute({
    summary: 'Reply',
    path: '/api/v1/support/tickets/{id}/messages',
    description: 'A resolved request opens again. Closed requests take no replies.',
    message: 'Reply sent',
    status: HttpStatus.CREATED,
    model: TicketDetailDto,
    example: TICKET_EXAMPLE,
    errors: [
      HttpStatus.BAD_REQUEST,
      ...REQUESTER_ERRORS,
      NOT_FOUND,
      { status: HttpStatus.CONFLICT, message: 'This request is closed. Open a new one' },
    ],
  })
  @Post(':id/messages')
  reply(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TicketReplyDto,
  ): Promise<TicketDetailDto> {
    return this.support.reply(user, id, dto.body);
  }

  @ApiBearerAuth()
  @Roles('customer', 'vendor')
  @HttpCode(HttpStatus.OK)
  @ApiRoute({
    summary: 'Close my request',
    path: '/api/v1/support/tickets/{id}/close',
    description: 'When it is sorted. Closing twice changes nothing.',
    message: 'Request closed',
    model: TicketDetailDto,
    example: { ...TICKET_EXAMPLE, status: 'closed', canReply: false },
    errors: [...REQUESTER_ERRORS, NOT_FOUND],
  })
  @Post(':id/close')
  close(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<TicketDetailDto> {
    return this.support.close(user, id);
  }
}

@ApiTags('Admin Help Desk')
@ApiBearerAuth()
@Roles(...STAFF_ROLES)
@Controller('admin/tickets')
export class AdminSupportController {
  constructor(private readonly support: SupportService) {}

  @ApiRoute({
    summary: 'Help desk queue',
    path: '/api/v1/admin/tickets',
    description:
      'Urgent first, then latest activity. Filter by status, category, priority or assignee (`me`, `none`, an id); search by ticket or order number, email or subject.',
    message: 'Requests retrieved',
    model: AdminTicketSummaryDto,
    paginated: true,
    errors: [HttpStatus.BAD_REQUEST, ...ADMIN_ERRORS],
  })
  @Get()
  list(@CurrentUser() admin: AuthUser, @Query() q: AdminTicketsQueryDto): Promise<Page<AdminTicketSummaryDto>> {
    return this.support.adminList(admin, q);
  }

  @ApiRoute({
    summary: 'One request',
    path: '/api/v1/admin/tickets/{id}',
    message: 'Request retrieved',
    model: AdminTicketDetailDto,
    example: ADMIN_EXAMPLE,
    errors: [...ADMIN_ERRORS, NOT_FOUND],
  })
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<AdminTicketDetailDto> {
    return this.support.adminDetail(id);
  }

  @ApiRoute({
    summary: 'Reply to the requester',
    path: '/api/v1/admin/tickets/{id}/messages',
    description:
      'Signed "Fysi Support". Emailed to the requester and put in their inbox. Sets the status (default `pending`: waiting for them) and assigns the request to you if nobody owns it.',
    message: 'Reply sent',
    status: HttpStatus.CREATED,
    model: AdminTicketDetailDto,
    example: { ...ADMIN_EXAMPLE, status: 'pending', messageCount: 2 },
    errors: [
      HttpStatus.BAD_REQUEST,
      ...ADMIN_ERRORS,
      NOT_FOUND,
      { status: HttpStatus.CONFLICT, message: 'This request is closed' },
    ],
  })
  @Post(':id/messages')
  reply(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StaffReplyDto,
  ): Promise<AdminTicketDetailDto> {
    return this.support.staffReply(admin, id, dto);
  }

  @ApiRoute({
    summary: 'Change status, priority or assignee',
    path: '/api/v1/admin/tickets/{id}',
    message: 'Request updated',
    model: AdminTicketDetailDto,
    example: { ...ADMIN_EXAMPLE, priority: 'high' },
    errors: [HttpStatus.BAD_REQUEST, ...ADMIN_ERRORS, NOT_FOUND],
  })
  @Patch(':id')
  update(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTicketDto,
  ): Promise<AdminTicketDetailDto> {
    return this.support.update(admin, id, dto);
  }
}
