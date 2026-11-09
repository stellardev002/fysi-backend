import {
  Horizon,
  NotFoundError,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

export interface LedgerBalance {
  /** `XLM` or `CODE:ISSUER`, the same ids as the asset allowlist. */
  assetId: string;
  balance: string;
  /** Trustline limit; null for XLM. */
  limit: string | null;
}

export interface LedgerAccount {
  address: string;
  sequence: string;
  balances: LedgerBalance[];
}

/** Thrown when Horizon cannot be reached or answers with a server error. */
export class LedgerUnavailableError extends Error {}

/** What the network did with a submitted transaction. */
export type SubmitOutcome =
  | { kind: 'success'; ledger: number }
  /** Rejected or failed on chain; `codes` are Stellar result codes, e.g. `op_underfunded`. */
  | { kind: 'failed'; codes: string[] };

/** A transaction as recorded on the ledger. */
export type LedgerTransaction =
  | { found: false }
  | { found: true; successful: boolean; ledger: number; closedAt: Date };

/**
 * Access to the Stellar ledger. An abstract class so tests swap in a fake
 * and the app never depends on Horizon being reachable during tests.
 */
export abstract class StellarLedger {
  /** Null when the account has never been funded (does not exist on chain). */
  abstract loadAccount(address: string): Promise<LedgerAccount | null>;

  /** Current base fee per operation, in stroops. */
  abstract baseFee(): Promise<number>;

  /**
   * Submits a signed transaction. Throws LedgerUnavailableError when the outcome
   * is unknown (timeout, Horizon down): the transaction may still land, so look it up later.
   */
  abstract submit(
    xdr: string,
    networkPassphrase: string,
  ): Promise<SubmitOutcome>;

  abstract findTransaction(hash: string): Promise<LedgerTransaction>;
}

const resultCodes = (err: unknown): string[] | null => {
  const codes = (
    err as {
      response?: {
        data?: {
          extras?: {
            result_codes?: { transaction?: string; operations?: string[] };
          };
        };
      };
    }
  )?.response?.data?.extras?.result_codes;
  if (!codes) return null;
  return [codes.transaction, ...(codes.operations ?? [])].filter(
    (c): c is string => !!c && c !== 'op_success',
  );
};

const balanceId = (b: Horizon.HorizonApi.BalanceLine): string | null => {
  if (b.asset_type === 'native') return 'XLM';
  if (
    b.asset_type === 'credit_alphanum4' ||
    b.asset_type === 'credit_alphanum12'
  )
    return `${b.asset_code}:${b.asset_issuer}`;
  return null; // Liquidity pool shares are not payable assets.
};

export class HorizonLedger extends StellarLedger {
  private readonly server: Horizon.Server;

  constructor(horizonUrl: string) {
    super();
    this.server = new Horizon.Server(horizonUrl);
  }

  async loadAccount(address: string): Promise<LedgerAccount | null> {
    try {
      const account = await this.server.loadAccount(address);
      return {
        address: account.accountId(),
        sequence: account.sequenceNumber(),
        balances: account.balances.flatMap((b) => {
          const assetId = balanceId(b);
          return assetId
            ? [
                {
                  assetId,
                  balance: b.balance,
                  limit: 'limit' in b ? b.limit : null,
                },
              ]
            : [];
        }),
      };
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw unavailable(err);
    }
  }

  async baseFee(): Promise<number> {
    try {
      return await this.server.fetchBaseFee();
    } catch (err) {
      throw unavailable(err);
    }
  }

  async submit(xdr: string, networkPassphrase: string): Promise<SubmitOutcome> {
    const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
    try {
      const res = await this.server.submitTransaction(tx, {
        skipMemoRequiredCheck: true,
      });
      return { kind: 'success', ledger: res.ledger };
    } catch (err) {
      // A 400 with result codes is a definite answer; anything else (timeout, 5xx) is not.
      const codes = resultCodes(err);
      if (codes) return { kind: 'failed', codes };
      throw unavailable(err);
    }
  }

  async findTransaction(hash: string): Promise<LedgerTransaction> {
    try {
      const tx = await this.server.transactions().transaction(hash).call();
      return {
        found: true,
        successful: tx.successful,
        ledger: tx.ledger_attr,
        closedAt: new Date(tx.created_at),
      };
    } catch (err) {
      if (err instanceof NotFoundError) return { found: false };
      throw unavailable(err);
    }
  }
}

const unavailable = (err: unknown) =>
  new LedgerUnavailableError(
    `Horizon request failed: ${(err as Error).message}`,
    {
      cause: err,
    },
  );
