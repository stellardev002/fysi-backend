import {
  createMongoAbility,
  type MongoAbility,
  type RawRuleOf,
} from '@casl/ability';
import { Injectable } from '@nestjs/common';
import type { AuthUser } from '../auth/auth-user.js';
import { isStaff } from '../database/schema/index.js';

export type Action = 'manage' | 'create' | 'read' | 'update' | 'delete';
export type Subject = 'User' | 'AuditLog' | 'all';
export type AppAbility = MongoAbility<[Action, Subject]>;

/**
 * Who may do what to which record. Role checks (`@Roles`) gate whole routes;
 * these rules gate individual records, e.g. a vendor may only touch their own.
 */
@Injectable()
export class AbilityFactory {
  forUser(user: AuthUser): AppAbility {
    const rules: RawRuleOf<AppAbility>[] = [];
    if (isStaff(user.role)) {
      rules.push({ action: 'manage', subject: 'all' });
    } else {
      rules.push({
        action: ['read', 'update'],
        subject: 'User',
        conditions: { id: user.id },
      });
    }
    return createMongoAbility<AppAbility>(rules);
  }
}
