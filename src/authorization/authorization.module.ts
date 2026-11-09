import { Module } from '@nestjs/common';
import { AbilityFactory } from './ability.factory.js';
import { PoliciesGuard, RolesGuard } from './guards.js';

@Module({
  providers: [AbilityFactory, RolesGuard, PoliciesGuard],
  exports: [AbilityFactory, RolesGuard, PoliciesGuard],
})
export class AuthorizationModule {}
