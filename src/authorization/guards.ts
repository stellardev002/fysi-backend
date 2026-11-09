import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedRequest } from '../auth/auth-user.js';
import { AbilityFactory } from './ability.factory.js';
import { type PolicyHandler, POLICIES_KEY } from './policies.decorator.js';
import { ROLES_KEY } from './roles.decorator.js';
import type { Role } from '../database/schema/index.js';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required?.length) return true;
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (required.some((r) => req.user?.role === r)) return true;
    throw new ForbiddenException();
  }
}

@Injectable()
export class PoliciesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly abilities: AbilityFactory,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const handlers = this.reflector.getAllAndOverride<
      PolicyHandler[] | undefined
    >(POLICIES_KEY, [context.getHandler(), context.getClass()]);
    if (!handlers?.length) return true;

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!req.user) throw new ForbiddenException();
    req.ability = this.abilities.forUser(req.user);
    const ability = req.ability;
    if (handlers.every((h) => h(ability))) return true;
    throw new ForbiddenException();
  }
}
