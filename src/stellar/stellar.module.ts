import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../config/env.validation.js';
import { HorizonLedger, StellarLedger } from './ledger.js';
import { KeypairSigner, PlatformSigner, UnconfiguredSigner } from './signer.js';
import { StellarAccountsService } from './stellar-accounts.service.js';
import { StellarConfig } from './stellar.config.js';
import { StellarController } from './stellar.controller.js';

@Global()
@Module({
  providers: [
    {
      provide: StellarConfig,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvVars, true>) =>
        new StellarConfig({
          STELLAR_NETWORK: config.get('STELLAR_NETWORK', { infer: true }),
          STELLAR_HORIZON_URL: config.get('STELLAR_HORIZON_URL', {
            infer: true,
          }),
          STELLAR_ASSETS: config.get('STELLAR_ASSETS', { infer: true }),
        }),
    },
    {
      provide: StellarLedger,
      inject: [StellarConfig],
      useFactory: (config: StellarConfig) =>
        new HorizonLedger(config.horizonUrl),
    },
    {
      provide: PlatformSigner,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvVars, true>) => {
        const secret = config.get('STELLAR_PLATFORM_SECRET', { infer: true });
        return secret ? new KeypairSigner(secret) : new UnconfiguredSigner();
      },
    },
    StellarAccountsService,
  ],
  controllers: [StellarController],
  exports: [
    StellarConfig,
    StellarLedger,
    PlatformSigner,
    StellarAccountsService,
  ],
})
export class StellarModule {}
