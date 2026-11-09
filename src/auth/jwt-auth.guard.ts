import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { EnvVars } from '../config/env.validation.js';
import { getRequestContext } from '../common/request-context.js';
import { type Role, roleEnum } from '../database/schema/index.js';
import { Database } from '../database/database.js';
import type { AuthenticatedRequest } from './auth-user.js';
import { familyExists } from './auth.queries.js';
import {
  ALLOW_WITHOUT_MFA_KEY,
  IS_OPTIONAL_AUTH_KEY,
  IS_PUBLIC_KEY,
} from './decorators.js';
import { MfaPolicy } from './mfa.policy.js';

/** Sent as the 403 message so clients can route to 2FA setup. */
export const MFA_SETUP_REQUIRED = 'Turn on two-factor sign-in to continue';

interface AccessTokenPayload {
  sub: string;
  role: Role;
  fid: string;
  mfa?: boolean;
}

const isPayload = (p: unknown): p is AccessTokenPayload =>
  typeof p === 'object' &&
  p !== null &&
  typeof (p as AccessTokenPayload).sub === 'string' &&
  typeof (p as AccessTokenPayload).fid === 'string' &&
  roleEnum.enumValues.includes((p as AccessTokenPayload).role);

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly secret: string;
  private readonly issuer: string;

  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
    private readonly database: Database,
    private readonly mfa: MfaPolicy,
    config: ConfigService<EnvVars, true>,
  ) {
    this.secret = config.get('JWT_ACCESS_SECRET', { infer: true });
    this.issuer = config.get('APP_NAME', { infer: true });
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const isOptional = this.reflector.getAllAndOverride<boolean>(
      IS_OPTIONAL_AUTH_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (isOptional && !req.headers.authorization) return true;

    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedException();

    let payload: unknown;
    try {
      payload = await this.jwt.verifyAsync(token, {
        secret: this.secret,
        algorithms: ['HS256'],
        issuer: this.issuer,
      });
    } catch {
      throw new UnauthorizedException();
    }
    if (!isPayload(payload)) throw new UnauthorizedException();
    if (!(await familyExists(this.database.db, payload.fid)))
      throw new UnauthorizedException();

    req.user = {
      id: payload.sub,
      role: payload.role,
      familyId: payload.fid,
      mfa: payload.mfa === true,
    };
    const ctx = getRequestContext();
    if (ctx) ctx.userId = payload.sub;

    // Enabling 2FA revokes every session, so a session without it means not set up.
    // Optional-auth (public) routes stay open: they only personalise.
    if (!isOptional && !req.user.mfa && this.mfa.requiredFor(req.user.role)) {
      const allowed = this.reflector.getAllAndOverride<boolean>(
        ALLOW_WITHOUT_MFA_KEY,
        [context.getHandler(), context.getClass()],
      );
      if (!allowed) throw new ForbiddenException(MFA_SETUP_REQUIRED);
    }
    return true;
  }
}
