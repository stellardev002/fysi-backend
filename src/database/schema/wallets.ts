import {
  index,
  integer,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { v7 } from 'uuid';
import { users } from './users.js';

/**
 * vendor: created on approval (PRD V4). customer: on request (C9).
 * settlement: the platform account that receives every payment, holds escrow,
 * sponsors reserves and pays network fees.
 */
export const walletKindEnum = pgEnum('wallet_kind', [
  'vendor',
  'customer',
  'settlement',
]);
export type WalletKind = (typeof walletKindEnum.enumValues)[number];

/** pending: key exists, account not yet on chain (activation retried). */
export const walletStatusEnum = pgEnum('wallet_status', ['pending', 'active']);
export type WalletStatus = (typeof walletStatusEnum.enumValues)[number];

export const wallets = pgTable(
  'wallets',
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => v7()),
    kind: walletKindEnum().notNull(),
    // Null for the settlement account.
    userId: uuid().references(() => users.id, { onDelete: 'restrict' }),
    publicKey: text().notNull().unique(),
    // Which custody backend holds the key, and its handle for it. For the
    // testnet-only `local` provider the handle is the sealed secret key.
    provider: text().notNull(),
    providerRef: text().notNull(),
    status: walletStatusEnum().notNull().default('pending'),
    activationError: text(),
    activationAttempts: integer().notNull().default(0),
    activatedAt: timestamp({ withTimezone: true }),
    // Customer wallets: KYC tier (1 = email + phone, capped; 2 = BVN/NIN).
    kycTier: smallint(),
    // Customer wallets: argon2 hash of the 6-digit payment PIN.
    pinHash: text(),
    pinFailures: integer().notNull().default(0),
    pinLockedUntil: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // One wallet per user and kind; one settlement account.
    uniqueIndex('wallets_user_kind_idx').on(t.userId, t.kind),
    uniqueIndex('wallets_single_settlement_idx')
      .on(t.kind)
      .where(sql`${t.kind} = 'settlement'`),
    index('wallets_status_idx').on(t.status),
  ],
).enableRLS();
