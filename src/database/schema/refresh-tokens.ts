import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';

// Row exists = token is valid. Rotation and logout delete the row.
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    tokenHash: text().primaryKey(),
    familyId: uuid().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // The session passed a second factor; carried into every rotated token.
    mfa: boolean().notNull().default(false),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('refresh_tokens_family_idx').on(t.familyId),
    index('refresh_tokens_user_idx').on(t.userId),
  ],
).enableRLS();
