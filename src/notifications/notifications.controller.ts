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
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser } from '../auth/decorators.js';
import { Roles } from '../authorization/roles.decorator.js';
import { ApiRoute } from '../common/api-docs.js';
import { type Page, PaginationQueryDto } from '../common/pagination.js';
import { STAFF_ROLES } from '../database/schema/index.js';
import {
  BroadcastDto,
  BroadcastSummaryDto,
  InboxQueryDto,
  NotificationDto,
  ReadAllResultDto,
  UnreadCountDto,
} from './dto/notifications.dto.js';
import { NotificationsService } from './notifications.service.js';

const NOTIFICATION_EXAMPLE = {
  id: '0197c2c0-1111-7a2b-b3c4-1d2e3f4a5b6c',
  kind: 'order.shipped',
  title: 'EcoThreads Lagos shipped your items',
  body: 'Order FYK3M9QXWA · GIG Logistics GIG-4471',
  link: '/account/orders/0197c2b0-2222-7a2b-b3c4-1d2e3f4a5b6c',
  data: { orderId: '0197c2b0-2222-7a2b-b3c4-1d2e3f4a5b6c' },
  read: false,
  readAt: null,
  createdAt: '2026-11-10T09:30:00.000Z',
};
const NOT_FOUND = { status: HttpStatus.NOT_FOUND, message: 'Notification not found' };

@ApiTags('Inbox')
@ApiBearerAuth()
@Controller('inbox')
export class InboxController {
  constructor(private readonly notifications: NotificationsService) {}

  @ApiRoute({
    summary: 'My inbox',
    path: '/api/v1/inbox',
    description:
      'Every role has one: order updates, vendor decisions, help desk replies and announcements from Fysi. Newest first.',
    message: 'Notifications retrieved',
    model: NotificationDto,
    paginated: true,
    errors: [HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED],
  })
  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: InboxQueryDto): Promise<Page<NotificationDto>> {
    return this.notifications.list(user.id, q);
  }

  @ApiRoute({
    summary: 'Unread count',
    path: '/api/v1/inbox/unread-count',
    description: 'For the bell badge.',
    message: 'Unread count retrieved',
    model: UnreadCountDto,
    example: { unread: 3 },
    errors: [HttpStatus.UNAUTHORIZED],
  })
  @Get('unread-count')
  async unread(@CurrentUser() user: AuthUser): Promise<UnreadCountDto> {
    return { unread: await this.notifications.unreadCount(user.id) };
  }

  @HttpCode(HttpStatus.OK)
  @ApiRoute({
    summary: 'Mark everything read',
    path: '/api/v1/inbox/read-all',
    message: 'Inbox marked read',
    model: ReadAllResultDto,
    example: { updated: 3 },
    errors: [HttpStatus.UNAUTHORIZED],
  })
  @Post('read-all')
  async readAll(@CurrentUser() user: AuthUser): Promise<ReadAllResultDto> {
    return { updated: await this.notifications.markAllRead(user.id) };
  }

  @HttpCode(HttpStatus.OK)
  @ApiRoute({
    summary: 'Mark one read',
    path: '/api/v1/inbox/{id}/read',
    message: 'Notification marked read',
    model: NotificationDto,
    example: { ...NOTIFICATION_EXAMPLE, read: true, readAt: '2026-11-10T09:31:00.000Z' },
    errors: [HttpStatus.UNAUTHORIZED, NOT_FOUND],
  })
  @Post(':id/read')
  read(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<NotificationDto> {
    return this.notifications.markRead(user.id, id);
  }

  @ApiRoute({
    summary: 'Delete a notification',
    path: '/api/v1/inbox/{id}',
    message: 'Notification deleted',
    errors: [HttpStatus.UNAUTHORIZED, NOT_FOUND],
  })
  @Delete(':id')
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<null> {
    await this.notifications.remove(user.id, id);
    return null;
  }
}

@ApiTags('Admin Notifications')
@ApiBearerAuth()
@Roles(...STAFF_ROLES)
@Controller('admin/notifications')
export class AdminNotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @ApiRoute({
    summary: 'Sent announcements',
    path: '/api/v1/admin/notifications',
    description: 'Broadcasts sent to inboxes, with how many recipients read each one.',
    message: 'Announcements retrieved',
    model: BroadcastSummaryDto,
    paginated: true,
    errors: [HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN],
  })
  @Get()
  list(@Query() q: PaginationQueryDto): Promise<Page<BroadcastSummaryDto>> {
    return this.notifications.broadcasts(q);
  }

  @ApiRoute({
    summary: 'Send an announcement',
    path: '/api/v1/admin/notifications',
    description:
      'Puts a message in the inbox of every customer, every vendor, all staff, or chosen accounts. In-app only; for email use campaigns. Audited.',
    message: 'Announcement sent',
    status: HttpStatus.CREATED,
    model: BroadcastSummaryDto,
    example: {
      id: '0197c2c0-3333-7a2b-b3c4-1d2e3f4a5b6c',
      audience: 'vendors',
      title: 'Black Friday week starts Monday',
      body: 'Vendors: set up your promotions before Sunday.',
      link: '/vendor/promotions',
      recipientCount: 86,
      readCount: 0,
      sentBy: '0197c2a4-8f10-7a2b-b3c4-1d2e3f4a5b6c',
      sentByName: 'Ada Okafor',
      createdAt: '2026-11-10T09:30:00.000Z',
    },
    errors: [HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN],
  })
  @Post()
  send(@CurrentUser() admin: AuthUser, @Body() dto: BroadcastDto): Promise<BroadcastSummaryDto> {
    return this.notifications.broadcast(admin, dto);
  }
}
