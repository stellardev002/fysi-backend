import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { v7 } from 'uuid';
import { categories } from './categories.js';
import { users } from './users.js';

/**
 * draft → pending (submitted) → approved | rejected; rejected → pending on resubmit;
 * approved ⇄ suspended by an admin (PRD V3, A1).
 */
export const vendorStatusEnum = pgEnum('vendor_status', [
  'draft',
  'pending',
  'approved',
  'rejected',
  'suspended',
]);
export type VendorStatus = (typeof vendorStatusEnum.enumValues)[number];

export const directorIdTypeEnum = pgEnum('director_id_type', ['nin', 'bvn']);
export type DirectorIdType = (typeof directorIdTypeEnum.enumValues)[number];

// One business per vendor account, keyed by the account.
export const vendors = pgTable(
  'vendors',
  {
    userId: uuid()
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: vendorStatusEnum().notNull().default('draft'),
    businessName: text(),
    // Storefront address, fixed at first approval so links keep working.
    slug: text().unique(),
    description: text(),
    phone: text(),
    addressLine: text(),
    city: text(),
    state: text(),
    categoryId: uuid().references(() => categories.id, {
      onDelete: 'restrict',
    }),
    // CAC registration number, e.g. RC1234567 or BN1234567.
    cacNumber: text(),
    directorIdType: directorIdTypeEnum(),
    // NIN / BVN, encrypted with DATA_ENCRYPTION_KEY; admins see the last 4 digits only.
    directorIdEncrypted: text(),
    directorIdLast4: text(),
    logoKey: text(),
    // Certifications an admin accepted at approval (labels from certificate uploads).
    verifiedCertifications: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // Latest decision note: the rejection or suspension reason shown to the vendor.
    decisionReason: text(),
    // Founding vendors pay 0% commission for their first 3 months (PRD decision).
    foundingVendor: boolean().notNull().default(false),
    submissionCount: integer().notNull().default(0),
    submittedAt: timestamp({ withTimezone: true }),
    reviewedAt: timestamp({ withTimezone: true }),
    reviewedBy: uuid(),
    approvedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index('vendors_status_idx').on(t.status, t.submittedAt)],
).enableRLS();

export const vendorDocumentKindEnum = pgEnum('vendor_document_kind', [
  'cac_certificate',
  'director_id',
  'proof_of_address',
  'sustainability_certificate',
  'sustainability_evidence',
]);
export type VendorDocumentKind =
  (typeof vendorDocumentKindEnum.enumValues)[number];

// KYB and sustainability documents. Private: only the vendor and admins can open them.
export const vendorDocuments = pgTable(
  'vendor_documents',
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => v7()),
    vendorId: uuid()
      .notNull()
      .references(() => vendors.userId, { onDelete: 'cascade' }),
    kind: vendorDocumentKindEnum().notNull(),
    // Label a sustainability certificate proves, e.g. `gots`; null for other kinds.
    certification: text(),
    storageKey: text().notNull(),
    fileName: text().notNull(),
    contentType: text().notNull(),
    sizeBytes: integer().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('vendor_documents_vendor_idx').on(t.vendorId, t.createdAt)],
).enableRLS();
