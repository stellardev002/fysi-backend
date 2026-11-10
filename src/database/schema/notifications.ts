import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { v7 } from 'uuid';
import { users } from './users.js';

/** An admin message sent to many inboxes at once. */
export const notificationBroadcasts = pgTable(
  'notification_broadcasts',
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => v7()),
    // all | customers | vendors | staff
    audience: text().notNull(),
    title: text().notNull(),
    body: text().notNull(),
    link: text(),
    recipientCount: integer().notNull(),
    sentBy: uuid().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('notification_broadcasts_created_idx').on(t.createdAt.desc())],
).enableRLS();

/** In-app inbox for every role. */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => v7()),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // e.g. order.paid, order.shipped, ticket.reply, vendor.decision, announcement.
    kind: text().notNull(),
    title: text().notNull(),
    body: text().notNull(),
    // Frontend path to open, e.g. /account/orders/<id>.
    link: text(),
    data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    broadcastId: uuid().references(() => notificationBroadcasts.id, {
      onDelete: 'set null',
    }),
    readAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('notifications_user_idx').on(t.userId, t.createdAt.desc()),
    index('notifications_unread_idx').on(t.userId, t.readAt),
  ],
).enableRLS();
