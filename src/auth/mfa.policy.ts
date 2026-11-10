import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../config/env.validation.js';
import type { Role } from '../database/schema/index.js';

/** Which roles must sign in with a second factor. None by default (MFA_REQUIRED_ROLES). */
@Injectable()
export class MfaPolicy {
  private readonly roles: ReadonlySet<string>;

  constructor(config: ConfigService<EnvVars, true>) {
    this.roles = new Set(
      config
        .get('MFA_REQUIRED_ROLES', { infer: true })
        .split(',')
        .filter(Boolean),
    );
  }

  requiredFor(role: Role): boolean {
    return this.roles.has(role);
  }
}
