import { subject } from '@casl/ability';
import { describe, expect, it } from 'vitest';
import { AbilityFactory } from './ability.factory.js';

const factory = new AbilityFactory();
const vendor = factory.forUser({
  id: 'b1',
  role: 'vendor',
  familyId: 'f',
  mfa: true,
});
const superAdmin = factory.forUser({
  id: 's1',
  role: 'super_admin',
  familyId: 'f',
  mfa: true,
});
const admin = factory.forUser({
  id: 'a1',
  role: 'admin',
  familyId: 'f',
  mfa: true,
});

describe('AbilityFactory', () => {
  it('lets a vendor read and update only their own user record', () => {
    expect(vendor.can('read', subject('User', { id: 'b1' }) as never)).toBe(
      true,
    );
    expect(vendor.can('update', subject('User', { id: 'b1' }) as never)).toBe(
      true,
    );
    expect(vendor.can('read', subject('User', { id: 'b2' }) as never)).toBe(
      false,
    );
    expect(vendor.can('delete', subject('User', { id: 'b1' }) as never)).toBe(
      false,
    );
  });

  it('keeps vendors out of the audit log', () => {
    expect(vendor.can('read', 'AuditLog')).toBe(false);
  });

  it('lets admins and super admins manage everything', () => {
    expect(admin.can('read', 'AuditLog')).toBe(true);
    expect(superAdmin.can('read', 'AuditLog')).toBe(true);
    expect(admin.can('delete', subject('User', { id: 'b2' }) as never)).toBe(
      true,
    );
  });
});
