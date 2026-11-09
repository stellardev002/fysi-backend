import {
  type FeeBumpTransaction,
  Keypair,
  type Transaction,
} from '@stellar/stellar-sdk';

/**
 * The platform's own Stellar key, from STELLAR_PLATFORM_SECRET. Phase 1 signs
 * nothing with it; phase 2 moves payment signing behind the wallet service (MPC custody), so it must belong to
 * an account with no balance worth stealing.
 *
 * Kept behind an interface so the secret can later move into a KMS/HSM
 * without touching callers. Nothing outside this file sees the secret.
 */
export abstract class PlatformSigner {
  abstract readonly configured: boolean;
  /** The G... address wallets see as the challenge's server account. */
  abstract publicKey(): string;
  abstract sign<T extends Transaction | FeeBumpTransaction>(tx: T): T;
}

export class SignerUnavailableError extends Error {
  constructor() {
    super('STELLAR_PLATFORM_SECRET is not set: platform signing is disabled');
  }
}

export class KeypairSigner extends PlatformSigner {
  readonly configured = true;
  readonly #keypair: Keypair;

  constructor(secret: string) {
    super();
    try {
      this.#keypair = Keypair.fromSecret(secret);
    } catch {
      // Never echo the value: it is a secret.
      throw new Error(
        'STELLAR_PLATFORM_SECRET is not a valid Stellar secret key',
      );
    }
  }

  publicKey(): string {
    return this.#keypair.publicKey();
  }

  sign<T extends Transaction | FeeBumpTransaction>(tx: T): T {
    tx.sign(this.#keypair);
    return tx;
  }
}

export class UnconfiguredSigner extends PlatformSigner {
  readonly configured = false;

  publicKey(): string {
    throw new SignerUnavailableError();
  }

  sign<T>(): T {
    throw new SignerUnavailableError();
  }
}
