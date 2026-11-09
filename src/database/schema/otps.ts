import {
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const otpPurposeEnum = pgEnum('otp_purpose', [
  'verify_email',
  'reset_password',
  // Confirms a vendor withdrawal (PRD: password + email OTP).
  'withdrawal',
]);

export type OtpPurpose = (typeof otpPurposeEnum.enumValues)[number];

// At most one live code per user and purpose; issuing a new one replaces the old.
export const otps = pgTable(
  'otps',
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: otpPurposeEnum().notNull(),
    codeHash: text().notNull(),
    attempts: integer().notNull().default(0),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.purpose] })],
).enableRLS();
