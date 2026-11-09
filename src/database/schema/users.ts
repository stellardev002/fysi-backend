import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { v7 } from 'uuid';
import { roleEnum } from './role.js';

export const users = pgTable(
  'users',
  {
    // Generated in the app so the schema runs on any Postgres version.
    id: uuid()
      .primaryKey()
      .$defaultFn(() => v7()),
    email: text().notNull().unique(),
    passwordHash: text().notNull(),
    role: roleEnum().notNull(),
    name: text().notNull(),
    // E.164, e.g. +2348031234567. Custodial wallet Tier 1 needs it (phase 2).
    phone: text(),
    // Profile picture in object storage.
    avatarKey: text(),
    // Null until the emailed OTP is confirmed; login is refused while null.
    emailVerifiedAt: timestamp({ withTimezone: true }),
    // TOTP secret, encrypted with DATA_ENCRYPTION_KEY. Stored at setup, live once enabled.
    totpSecret: text(),
    totpEnabledAt: timestamp({ withTimezone: true }),
    // Last accepted 30-second step, so one code works once.
    totpLastStep: bigint({ mode: 'number' }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [check('users_email_lowercase', sql`${t.email} = lower(${t.email})`)],
).enableRLS();
