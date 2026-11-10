import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, count, desc, eq, inArray, isNull, notExists, sql } from 'drizzle-orm';
import { v7 } from 'uuid';
import { recordAudit } from '../audit/audit.queries.js';
import type { AuthUser } from '../auth/auth-user.js';
import { type Page, type PaginationQueryDto, toPage } from '../common/pagination.js';
import { Database, type Executor } from '../database/database.js';
import {
  notificationBroadcasts,
  notifications,
  type Role,
  STAFF_ROLES,
  userSuspensions,
  users,
} from '../database/schema/index.js';
import type {
  BroadcastDto,
  BroadcastSummaryDto,
  InboxQueryDto,
  NotificationDto,
} from './dto/notifications.dto.js';

export interface NewNotification {
  kind: string;
  title: string;
  body: string;
  link?: string | null;
  data?: Record<string, unknown>;
}

const CHUNK = 1000;

/** Accounts that can still sign in: not deleted, not suspended. */
const activeUser = () =>
  and(
    isNull(users.deletedAt),
    notExists(
      sql`(select 1 from ${userSuspensions} where ${userSuspensions.userId} = ${users.id})`,
    ),
  );

/** In-app inbox for every role, and admin broadcasts to it. */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly database: Database) {}

  /** Inside a transaction, the notification commits with the change it describes. */
  async notify(db: Executor, userIds: string | string[], n: NewNotification, broadcastId?: string) {
    const ids = [...new Set(Array.isArray(userIds) ? userIds : [userIds])];
    for (let i = 0; i < ids.length; i += CHUNK)
      await db.insert(notifications).values(
        ids.slice(i, i + CHUNK).map((userId) => ({
          id: v7(),
          userId,
          kind: n.kind,
          title: n.title,
          body: n.body,
          link: n.link ?? null,
          data: n.data ?? {},
          broadcastId: broadcastId ?? null,
        })),
      );
  }

  /** After a commit: a failure is logged, never thrown into the caller's flow. */
  async notifyLater(userIds: string | string[], n: NewNotification): Promise<void> {
    try {
      await this.notify(this.database.db, userIds, n);
    } catch (err) {
      this.logger.error({ err, kind: n.kind }, 'Failed to write notification');
    }
  }

  /** Every active admin and super admin. */
  async notifyStaff(db: Executor, n: NewNotification) {
    const staff = await this.activeUserIds(db, [...STAFF_ROLES]);
    if (staff.length > 0) await this.notify(db, staff, n);
  }

  async notifyStaffLater(n: NewNotification): Promise<void> {
    try {
      await this.notifyStaff(this.database.db, n);
    } catch (err) {
      this.logger.error({ err, kind: n.kind }, 'Failed to notify staff');
    }
  }

  /* ---------------- inbox ---------------- */

  async list(userId: string, q: InboxQueryDto): Promise<Page<NotificationDto>> {
    const where = and(
      eq(notifications.userId, userId),
      q.unread ? isNull(notifications.readAt) : undefined,
    );
    const db = this.database.db;
    const [rows, [{ total }]] = await Promise.all([
      db
        .select()
        .from(notifications)
        .where(where)
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(q.limit)
        .offset(q.offset),
      db.select({ total: count() }).from(notifications).where(where),
    ]);
    return toPage(rows.map(toDto), total, q);
  }

  async unreadCount(userId: string): Promise<number> {
    const [{ n }] = await this.database.db
      .select({ n: count() })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
    return n;
  }

  async markRead(userId: string, id: string): Promise<NotificationDto> {
    const db = this.database.db;
    const own = and(eq(notifications.id, id), eq(notifications.userId, userId));
    await db
      .update(notifications)
      .set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
      .where(own);
    const [row] = await db.select().from(notifications).where(own).limit(1);
    if (!row) throw new NotFoundException('Notification not found');
    return toDto(row);
  }

  async markAllRead(userId: string): Promise<number> {
    const rows = await this.database.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
      .returning({ id: notifications.id });
    return rows.length;
  }

  async remove(userId: string, id: string): Promise<void> {
    const rows = await this.database.db
      .delete(notifications)
      .where(and(eq(notifications.id, id), eq(notifications.userId, userId)))
      .returning({ id: notifications.id });
    if (rows.length === 0) throw new NotFoundException('Notification not found');
  }

  /* ---------------- admin ---------------- */

  async broadcast(admin: AuthUser, dto: BroadcastDto): Promise<BroadcastSummaryDto> {
    const id = await this.database.transaction(async (tx) => {
      const recipients =
        dto.audience === 'users'
          ? await this.activeUserIds(tx, undefined, dto.userIds)
          : await this.activeUserIds(
              tx,
              dto.audience === 'all'
                ? ['customer', 'vendor']
                : dto.audience === 'customers'
                  ? ['customer']
                  : dto.audience === 'vendors'
                    ? ['vendor']
                    : [...STAFF_ROLES],
            );
      const [b] = await tx
        .insert(notificationBroadcasts)
        .values({
          audience: dto.audience,
          title: dto.title,
          body: dto.body,
          link: dto.link ?? null,
          recipientCount: recipients.length,
          sentBy: admin.id,
        })
        .returning();
      await this.notify(
        tx,
        recipients,
        { kind: 'announcement', title: dto.title, body: dto.body, link: dto.link },
        b.id,
      );
      await recordAudit(tx, {
        action: 'notification.broadcast',
        actorId: admin.id,
        resourceType: 'notification_broadcast',
        resourceId: b.id,
        metadata: { audience: dto.audience, recipients: recipients.length, title: dto.title },
      });
      return b.id;
    });
    return (await this.broadcasts({ limit: 1, offset: 0 }, id)).result[0];
  }

  async broadcasts(q: PaginationQueryDto, id?: string): Promise<Page<BroadcastSummaryDto>> {
    const db = this.database.db;
    const where = id ? eq(notificationBroadcasts.id, id) : undefined;
    const [rows, [{ total }]] = await Promise.all([
      db
        .select({
          b: notificationBroadcasts,
          sentByName: users.name,
          readCount: sql<number>`(select count(*)::int from ${notifications} where ${notifications.broadcastId} = ${notificationBroadcasts.id} and ${notifications.readAt} is not null)`,
        })
        .from(notificationBroadcasts)
        .leftJoin(users, eq(users.id, notificationBroadcasts.sentBy))
        .where(where)
        .orderBy(desc(notificationBroadcasts.createdAt))
        .limit(q.limit)
        .offset(q.offset),
      db.select({ total: count() }).from(notificationBroadcasts).where(where),
    ]);
    return toPage(
      rows.map(({ b, sentByName, readCount }) => ({
        id: b.id,
        audience: b.audience,
        title: b.title,
        body: b.body,
        link: b.link,
        recipientCount: b.recipientCount,
        readCount: Number(readCount),
        sentBy: b.sentBy,
        sentByName,
        createdAt: b.createdAt,
      })),
      total,
      q,
    );
  }

  private async activeUserIds(db: Executor, roles?: Role[], ids?: string[]): Promise<string[]> {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          activeUser(),
          roles ? inArray(users.role, roles) : undefined,
          ids ? inArray(users.id, ids) : undefined,
        ),
      );
    return rows.map((r) => r.id);
  }
}

const toDto = (r: typeof notifications.$inferSelect): NotificationDto => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  body: r.body,
  link: r.link,
  data: r.data,
  read: r.readAt !== null,
  readAt: r.readAt,
  createdAt: r.createdAt,
});
