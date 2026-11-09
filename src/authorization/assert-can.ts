import { subject } from '@casl/ability';
import { ForbiddenException } from '@nestjs/common';
import type { Action, AppAbility } from './ability.factory.js';

/** Instance-level check, e.g. conditions like `{ id: user.id }`. */
export function assertCan(
  ability: AppAbility | undefined,
  action: Action,
  type: 'User' | 'AuditLog',
  resource: object,
): void {
  if (!ability?.can(action, subject(type, resource) as never)) {
    throw new ForbiddenException();
  }
}
