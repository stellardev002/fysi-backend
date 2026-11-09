import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SecretBox } from '../common/secret-box.js';
import type { EnvVars } from '../config/env.validation.js';
import { StellarConfig } from '../stellar/stellar.config.js';
import { CustodyProvider, LocalCustodyProvider } from './custody.js';
import { WalletsService } from './wallets.service.js';

@Module({
  providers: [
    {
      provide: CustodyProvider,
      inject: [ConfigService, StellarConfig, SecretBox],
      useFactory: (
        config: ConfigService<EnvVars, true>,
        stellar: StellarConfig,
        box: SecretBox,
      ): CustodyProvider => {
        const provider = config.get('WALLET_PROVIDER', { infer: true });
        if (provider === 'local') {
          if (!stellar.isTestnet)
            throw new Error(
              'WALLET_PROVIDER=local keeps keys in the app database and is testnet only. Configure an MPC custody provider for mainnet',
            );
          return new LocalCustodyProvider(box);
        }
        throw new Error(`Unknown WALLET_PROVIDER ${provider}`);
      },
    },
    WalletsService,
  ],
  exports: [WalletsService],
})
export class WalletsModule {}
