import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SecretBox } from '../common/secret-box.js';
import type { EnvVars } from '../config/env.validation.js';
import { CustodyProvider, LocalCustodyProvider } from './custody.js';
import { WalletsService } from './wallets.service.js';

@Module({
  providers: [
    {
      provide: CustodyProvider,
      inject: [ConfigService, SecretBox],
      useFactory: (config: ConfigService<EnvVars, true>, box: SecretBox): CustodyProvider => {
        const provider = config.get('WALLET_PROVIDER', { infer: true });
        // Testnet only (StellarConfig refuses anything else), where local keys are fine.
        if (provider === 'local') return new LocalCustodyProvider(box);
        throw new Error(`Unknown WALLET_PROVIDER ${provider}`);
      },
    },
    WalletsService,
  ],
  exports: [WalletsService],
})
export class WalletsModule {}
