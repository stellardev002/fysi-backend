import { Networks } from '@stellar/stellar-sdk';
import { StellarNetwork } from '../config/env.validation.js';
import { type AllowedAsset, parseAssetList } from './assets.js';

const DEFAULTS: Record<
  StellarNetwork,
  { passphrase: string; horizonUrl: string; explorerUrl: string }
> = {
  [StellarNetwork.Testnet]: {
    passphrase: Networks.TESTNET,
    horizonUrl: 'https://horizon-testnet.stellar.org',
    explorerUrl: 'https://stellar.expert/explorer/testnet',
  },
  [StellarNetwork.Mainnet]: {
    passphrase: Networks.PUBLIC,
    horizonUrl: 'https://horizon.stellar.org',
    explorerUrl: 'https://stellar.expert/explorer/public',
  },
};

/** Everything network-specific, resolved once from the environment. Nothing else hardcodes a network. */
export class StellarConfig {
  readonly network: StellarNetwork;
  readonly networkPassphrase: string;
  readonly horizonUrl: string;
  readonly explorerUrl: string;
  readonly assets: AllowedAsset[];

  constructor(env: {
    STELLAR_NETWORK: StellarNetwork;
    STELLAR_ALLOW_MAINNET: boolean;
    STELLAR_HORIZON_URL: string;
    STELLAR_ASSETS: string;
  }) {
    if (
      env.STELLAR_NETWORK === StellarNetwork.Mainnet &&
      !env.STELLAR_ALLOW_MAINNET
    )
      throw new Error(
        'STELLAR_NETWORK=mainnet moves real money: also set STELLAR_ALLOW_MAINNET=true once launch sign-off is done',
      );
    const defaults = DEFAULTS[env.STELLAR_NETWORK];
    this.network = env.STELLAR_NETWORK;
    this.networkPassphrase = defaults.passphrase;
    this.horizonUrl = (env.STELLAR_HORIZON_URL || defaults.horizonUrl).replace(
      /\/+$/,
      '',
    );
    this.explorerUrl = defaults.explorerUrl;
    this.assets = parseAssetList(env.STELLAR_ASSETS);
  }

  findAsset(id: string): AllowedAsset | undefined {
    return this.assets.find((a) => a.id === id);
  }

  transactionUrl(hash: string): string {
    return `${this.explorerUrl}/tx/${hash}`;
  }

  accountUrl(address: string): string {
    return `${this.explorerUrl}/account/${address}`;
  }
}
