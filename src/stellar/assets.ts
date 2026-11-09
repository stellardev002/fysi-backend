import { Asset } from '@stellar/stellar-sdk';
import { isAccountAddress } from './address.js';

export interface AllowedAsset {
  /** `XLM`, or `CODE:ISSUER`. Stable key for storage and comparison. */
  id: string;
  code: string;
  /** Null for native XLM. */
  issuer: string | null;
  native: boolean;
}

const ASSET_CODE = /^[A-Za-z0-9]{1,12}$/;

/** Parses one `XLM` or `CODE:ISSUER` entry. */
export function parseAsset(entry: string): AllowedAsset {
  const value = entry.trim();
  if (value.toUpperCase() === 'XLM' || value.toLowerCase() === 'native')
    return { id: 'XLM', code: 'XLM', issuer: null, native: true };
  const [code, issuer, ...rest] = value.split(':');
  if (rest.length > 0 || !code || !issuer)
    throw new Error(`Asset "${value}" must be XLM or CODE:ISSUER`);
  if (!ASSET_CODE.test(code))
    throw new Error(`Asset code "${code}" must be 1-12 letters or digits`);
  if (!isAccountAddress(issuer))
    throw new Error(`Asset issuer for ${code} is not a valid Stellar address`);
  return { id: `${code}:${issuer}`, code, issuer, native: false };
}

/** Parses the STELLAR_ASSETS allowlist; rejects duplicates and empty lists. */
export function parseAssetList(list: string): AllowedAsset[] {
  const assets = list
    .split(',')
    .filter((e) => e.trim())
    .map(parseAsset);
  if (assets.length === 0) throw new Error('STELLAR_ASSETS lists no assets');
  const ids = new Set<string>();
  for (const a of assets) {
    if (ids.has(a.id)) throw new Error(`Asset ${a.id} is listed twice`);
    ids.add(a.id);
  }
  return assets;
}

export const toSdkAsset = (asset: AllowedAsset): Asset =>
  asset.native ? Asset.native() : new Asset(asset.code, asset.issuer!);
