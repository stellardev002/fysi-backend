import type { Request } from 'express';
import type { AppAbility } from '../authorization/ability.factory.js';
import type { Role } from '../database/schema/index.js';

export interface AuthUser {
  id: string;
  role: Role;
  /** Refresh-token family this access token belongs to. */
  familyId: string;
  /** The session passed a second factor. */
  mfa: boolean;
}

export interface AuthenticatedRequest extends Request {
  user: AuthUser;
  ability?: AppAbility;
}
