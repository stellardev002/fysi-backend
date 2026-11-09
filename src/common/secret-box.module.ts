import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../config/env.validation.js';
import { SecretBox } from './secret-box.js';

@Global()
@Module({
  providers: [
    {
      provide: SecretBox,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvVars, true>) =>
        new SecretBox(config.get('DATA_ENCRYPTION_KEY', { infer: true })),
    },
  ],
  exports: [SecretBox],
})
export class SecretBoxModule {}
