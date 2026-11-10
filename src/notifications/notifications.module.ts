import { Global, Module } from '@nestjs/common';
import {
  AdminNotificationsController,
  InboxController,
} from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';

/** Global: orders, payments, vendors and support all write to inboxes. */
@Global()
@Module({
  controllers: [InboxController, AdminNotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
