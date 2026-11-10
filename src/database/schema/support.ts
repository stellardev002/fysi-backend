import {
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { v7 } from 'uuid';
import { orders, vendorOrders } from './orders.js';
import { products } from './products.js';
import { users } from './users.js';

export const ticketCategoryEnum = pgEnum('ticket_category', [
  'order',
  'payment',
  'delivery',
  'product',
  'account',
  'vendor',
  'other',
]);
export type TicketCategory = (typeof ticketCategoryEnum.enumValues)[number];

/** open (waiting on Fysi) ⇄ pending (waiting on the requester) → resolved → closed. */
export const ticketStatusEnum = pgEnum('ticket_status', [
  'open',
  'pending',
  'resolved',
  'closed',
]);
export type TicketStatus = (typeof ticketStatusEnum.enumValues)[number];

export const ticketPriorityEnum = pgEnum('ticket_priority', [
  'low',
  'normal',
  'high',
  'urgent',
]);
export type TicketPriority = (typeof ticketPriorityEnum.enumValues)[number];

/** Help desk: the Report a Problem form, order problem reports and contact requests. */
export const supportTickets = pgTable(
  'support_tickets',
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => v7()),
    // Human reference, e.g. TK7K3M9QXW.
    number: text().notNull().unique(),
    // Null for a guest; then email and name identify them.
    userId: uuid().references(() => users.id, { onDelete: 'set null' }),
    email: text().notNull(),
    name: text().notNull(),
    category: ticketCategoryEnum().notNull(),
    subject: text().notNull(),
    status: ticketStatusEnum().notNull().default('open'),
    priority: ticketPriorityEnum().notNull().default('normal'),
    orderId: uuid().references(() => orders.id, { onDelete: 'set null' }),
    vendorOrderId: uuid().references(() => vendorOrders.id, {
      onDelete: 'set null',
    }),
    productId: uuid().references(() => products.id, { onDelete: 'set null' }),
    assignedTo: uuid().references(() => users.id, { onDelete: 'set null' }),
    lastMessageAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('support_tickets_user_idx').on(t.userId, t.createdAt.desc()),
    index('support_tickets_queue_idx').on(t.status, t.lastMessageAt.desc()),
    index('support_tickets_vendor_order_idx').on(t.vendorOrderId),
  ],
).enableRLS();

export const ticketMessages = pgTable(
  'ticket_messages',
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => v7()),
    ticketId: uuid()
      .notNull()
      .references(() => supportTickets.id, { onDelete: 'cascade' }),
    authorId: uuid(),
    // requester | staff
    authorType: text().notNull(),
    authorName: text().notNull(),
    body: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ticket_messages_ticket_idx').on(t.ticketId, t.createdAt)],
).enableRLS();
