import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import type { EnvVars } from '../config/env.validation.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { MfaPolicy } from './mfa.policy.js';
import { ProfileImagesService } from './profile-images.service.js';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvVars, true>) => ({
        secret: config.get('JWT_ACCESS_SECRET', { infer: true }),
        signOptions: {
          algorithm: 'HS256',
          issuer: config.get('APP_NAME', { infer: true }),
          expiresIn: config.get('ACCESS_TOKEN_TTL_SECONDS', { infer: true }),
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, MfaPolicy, ProfileImagesService],
  exports: [AuthService, JwtAuthGuard, JwtModule, MfaPolicy],
})
export class AuthModule {}
