import { SetMetadata } from '@nestjs/common';
import type { AppAbility } from './ability.factory.js';

export type PolicyHandler = (ability: AppAbility) => boolean;

export const POLICIES_KEY = 'policies';

/** Route-level check on the caller's ability. Instance checks use `assertCan`. */
export const CheckPolicies = (...handlers: PolicyHandler[]) =>
  SetMetadata(POLICIES_KEY, handlers);
