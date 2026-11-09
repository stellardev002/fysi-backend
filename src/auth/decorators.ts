import {
  createParamDecorator,
  type ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { AuthenticatedRequest, AuthUser } from './auth-user.js';

export const IS_PUBLIC_KEY = 'isPublic';

/** Opts a route out of the global JWT guard. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const ALLOW_WITHOUT_MFA_KEY = 'allowWithoutMfa';

/**
 * Reachable by a role that must use 2FA but has not set it up yet: just
 * enough to see the account and turn 2FA on.
 */
export const AllowWithoutMfa = () => SetMetadata(ALLOW_WITHOUT_MFA_KEY, true);

export const IS_OPTIONAL_AUTH_KEY = 'isOptionalAuth';

/**
 * Route works anonymously. A valid bearer token still identifies the caller;
 * a token that is present but invalid is rejected with 401.
 */
export const OptionalAuth = () => SetMetadata(IS_OPTIONAL_AUTH_KEY, true);

/** The caller on an `@OptionalAuth()` route, or undefined when anonymous. */
export const OptionalUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser | undefined =>
    ctx.switchToHttp().getRequest<Partial<AuthenticatedRequest>>().user,
);

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser =>
    ctx.switchToHttp().getRequest<AuthenticatedRequest>().user,
);
