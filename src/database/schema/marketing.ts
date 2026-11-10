import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { v7 } from 'uuid';
import { users } from './users.js';

export const subscriberStatusEnum = pgEnum('subscriber_status', [
  'subscribed',
  'unsubscribed',
]);
export type SubscriberStatus = (typeof subscriberStatusEnum.enumValues)[number];

/**
 * Newsletter list, and the marketing opt-out list: an `unsubscribed` row also
 * keeps campaigns to customers and vendors away from that address.
 */
export const newsletterSubscribers = pgTable(
  'newsletter_subscribers',
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => v7()),
    email: text().notNull().unique(),
    userId: uuid().references(() => users.id, { onDelete: 'set null' }),
    status: subscriberStatusEnum().notNull().default('subscribed'),
    // Where the sign-up came from: footer, checkout, account…
    source: text(),
    subscribedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    unsubscribedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('newsletter_email_lowercase', sql`${t.email} = lower(${t.email})`),
    index('newsletter_status_idx').on(t.status, t.subscribedAt.desc()),
  ],
).enableRLS();

/** draft → scheduled → sending → sent; draft | scheduled → cancelled. */
export const campaignStatusEnum = pgEnum('campaign_status', [
  'draft',
  'scheduled',
  'sending',
  'sent',
  'cancelled',
]);
export type CampaignStatus = (typeof campaignStatusEnum.enumValues)[number];

export const campaignAudienceEnum = pgEnum('campaign_audience', [
  'newsletter',
  'customers',
  'vendors',
  'all_users',
]);
export type CampaignAudience = (typeof campaignAudienceEnum.enumValues)[number];

/** Admin email campaigns. */
export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => v7()),
    name: text().notNull(),
    subject: text().notNull(),
    preheader: text(),
    heading: text().notNull(),
    // Plain text; blank lines separate paragraphs.
    body: text().notNull(),
    ctaLabel: text(),
    ctaUrl: text(),
    audience: campaignAudienceEnum().notNull(),
    status: campaignStatusEnum().notNull().default('draft'),
    scheduledAt: timestamp({ withTimezone: true }),
    startedAt: timestamp({ withTimezone: true }),
    sentAt: timestamp({ withTimezone: true }),
    recipientCount: integer().notNull().default(0),
    sentCount: integer().notNull().default(0),
    failedCount: integer().notNull().default(0),
    createdBy: uuid().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('campaigns_status_idx').on(t.status, t.scheduledAt),
    index('campaigns_created_idx').on(t.createdAt.desc()),
  ],
).enableRLS();

export const deliveryStatusEnum = pgEnum('delivery_status', [
  'pending',
  'sent',
  'failed',
]);

/** Recipients fixed when sending starts; each is mailed once. */
export const campaignDeliveries = pgTable(
  'campaign_deliveries',
  {
    campaignId: uuid()
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    email: text().notNull(),
    status: deliveryStatusEnum().notNull().default('pending'),
    error: text(),
    sentAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.campaignId, t.email] }),
    index('campaign_deliveries_pending_idx').on(t.campaignId, t.status),
  ],
).enableRLS();
