import {
  type FeeBumpTransaction,
  Keypair,
  type Transaction,
} from '@stellar/stellar-sdk';
import { SecretBox } from '../common/secret-box.js';

export interface CustodyKey {
  publicKey: string;
  /** The provider's handle for the key; never the key itself in plain form. */
  ref: string;
}

/**
 * Where custodial keys live (PRD: MPC wallet-infrastructure provider, behind
 * Fysi's own wallet service so the provider can be swapped). Nothing outside
 * this file ever sees key material.
 */
export abstract class CustodyProvider {
  abstract readonly name: string;
  abstract createKey(): Promise<CustodyKey>;
  /** Adds the key's signature to the transaction. */
  abstract sign<T extends Transaction | FeeBumpTransaction>(
    key: CustodyKey,
    tx: T,
  ): Promise<T>;
}

/**
 * Testnet only: keys generated here and stored encrypted (AES-256-GCM, bound to
 * the public key) in the wallets table. Refused on mainnet at boot, because the
 * PRD requires keys never to sit in the app database.
 */
export class LocalCustodyProvider extends CustodyProvider {
  readonly name = 'local';

  constructor(private readonly box: SecretBox) {
    super();
  }

  createKey(): Promise<CustodyKey> {
    const kp = Keypair.random();
    return Promise.resolve({
      publicKey: kp.publicKey(),
      ref: this.box.seal(kp.secret(), `custody:${kp.publicKey()}`),
    });
  }

  sign<T extends Transaction | FeeBumpTransaction>(
    key: CustodyKey,
    tx: T,
  ): Promise<T> {
    const kp = Keypair.fromSecret(
      this.box.open(key.ref, `custody:${key.publicKey}`),
    );
    if (kp.publicKey() !== key.publicKey)
      throw new Error('Custody key does not match its wallet');
    tx.sign(kp);
    return Promise.resolve(tx);
  }
}
