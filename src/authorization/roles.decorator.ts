import { SetMetadata } from '@nestjs/common';
import type { Role } from '../database/schema/index.js';

export const ROLES_KEY = 'roles';

/** Route requires at least one of the listed roles. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
