import { Networks } from '@stellar/stellar-sdk';
import { StellarNetwork } from '../config/env.validation.js';
import { type AllowedAsset, parseAssetList } from './assets.js';

/**
 * Fysi runs on the Stellar **testnet only** for now: no real money moves.
 * There is no mainnet setting, and these guards refuse to boot if another
 * setting points at the public network anyway.
 */
const TESTNET = {
  passphrase: Networks.TESTNET,
  horizonUrl: 'https://horizon-testnet.stellar.org',
  explorerUrl: 'https://stellar.expert/explorer/testnet',
};

/** SDF's public-network Horizon hosts. */
const MAINNET_HORIZON_HOSTS = new Set(['horizon.stellar.org', 'horizon.stellar.lobstr.co']);

/** Circle's USDC issuer on the public network (real dollars). */
export const MAINNET_USDC_ISSUER =
  'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

/** Everything network-specific, resolved once from the environment. Nothing else hardcodes a network. */
export class StellarConfig {
  readonly network = StellarNetwork.Testnet;
  readonly networkPassphrase = TESTNET.passphrase;
  readonly horizonUrl: string;
  readonly explorerUrl = TESTNET.explorerUrl;
  readonly assets: AllowedAsset[];

  constructor(env: {
    STELLAR_NETWORK: StellarNetwork;
    STELLAR_HORIZON_URL: string;
    STELLAR_ASSETS: string;
  }) {
    if (env.STELLAR_NETWORK !== StellarNetwork.Testnet)
      throw new Error('Fysi runs on the Stellar testnet only: STELLAR_NETWORK must be testnet');
    this.horizonUrl = (env.STELLAR_HORIZON_URL || TESTNET.horizonUrl).replace(/\/+$/, '');
    let host: string;
    try {
      host = new URL(this.horizonUrl).hostname;
    } catch {
      throw new Error('STELLAR_HORIZON_URL is not a valid URL');
    }
    if (MAINNET_HORIZON_HOSTS.has(host))
      throw new Error(
        `STELLAR_HORIZON_URL points at the public network (${host}); Fysi runs on testnet only`,
      );
    this.assets = parseAssetList(env.STELLAR_ASSETS);
    if (this.assets.some((a) => a.issuer === MAINNET_USDC_ISSUER))
      throw new Error(
        "STELLAR_ASSETS uses Circle's mainnet USDC issuer; use the testnet issuer GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      );
  }

  /** The asset orders are paid in: the first issued (non-XLM) asset, i.e. USDC. */
  get settlementAsset(): AllowedAsset {
    const asset = this.assets.find((a) => !a.native);
    if (!asset)
      throw new Error(
        'STELLAR_ASSETS needs the settlement asset as CODE:ISSUER (USDC)',
      );
    return asset;
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
