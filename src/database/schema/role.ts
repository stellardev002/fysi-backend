import { pgEnum } from 'drizzle-orm/pg-core';

// PRD roles. Super admins also manage admin accounts (PRD A7).
export const roleEnum = pgEnum('role', [
  'customer',
  'vendor',
  'admin',
  'super_admin',
]);

export type Role = (typeof roleEnum.enumValues)[number];

/** Roles that can use the admin console. */
export const STAFF_ROLES = ['admin', 'super_admin'] as const satisfies Role[];

export const isStaff = (role: Role): boolean =>
  (STAFF_ROLES as readonly Role[]).includes(role);
