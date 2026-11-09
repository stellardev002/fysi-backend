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

/** A payment operation (payment or path payment), as Horizon lists it. */
export interface LedgerPayment {
  /** Operation id: unique across the network. */
  id: string;
  pagingToken: string;
  txHash: string;
  ledger: number;
  closedAt: Date;
  from: string;
  to: string;
  /** `XLM` or `CODE:ISSUER`. */
  assetId: string;
  /** Decimal string, 7 places. */
  amount: string;
  /** Text or id memo of the transaction, as a string; null without one. */
  memo: string | null;
  successful: boolean;
}

export interface PaymentsPage {
  records: LedgerPayment[];
  /**
   * Paging token of the last operation Horizon returned, including ones that
   * are not payments (account creation, trustlines), so a reader never stalls
   * on them. Null when the page was empty.
   */
  cursor: string | null;
}

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

  /**
   * Payments into and out of `address`, oldest first after `cursor` (a paging
   * token), or newest first with `order: 'desc'`. Failed transactions are left out.
   */
  abstract paymentsFor(
    address: string,
    opts: { cursor?: string; limit: number; order?: 'asc' | 'desc' },
  ): Promise<PaymentsPage>;

  /** Testnet only: funds a new account with Friendbot's test XLM. */
  abstract fundWithFriendbot(address: string): Promise<void>;
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

  async paymentsFor(
    address: string,
    opts: { cursor?: string; limit: number; order?: 'asc' | 'desc' },
  ): Promise<PaymentsPage> {
    try {
      let call = this.server
        .payments()
        .forAccount(address)
        .order(opts.order ?? 'asc')
        .limit(opts.limit)
        .join('transactions');
      if (opts.cursor) call = call.cursor(opts.cursor);
      const page = await call.call();
      const raw = page.records as unknown as HorizonPaymentRecord[];
      const records = raw
        .filter((r) => PAYMENT_TYPES.has(r.type) && r.transaction_successful !== false)
        .map((r) => ({
          id: r.id,
          pagingToken: r.paging_token,
          txHash: r.transaction_hash,
          ledger: r.transaction_attr?.ledger_attr ?? r.transaction_attr?.ledger ?? 0,
          closedAt: new Date(r.created_at),
          from: r.from ?? '',
          to: r.to ?? '',
          assetId:
            r.asset_type === 'native' ? 'XLM' : `${r.asset_code}:${r.asset_issuer}`,
          amount: r.amount ?? '0',
          memo:
            r.transaction_attr?.memo_type === 'text' ||
            r.transaction_attr?.memo_type === 'id'
              ? (r.transaction_attr.memo ?? null)
              : null,
          successful: r.transaction_successful !== false,
        }));
      return { records, cursor: raw.at(-1)?.paging_token ?? null };
    } catch (err) {
      // An account that does not exist yet has no payments.
      if (err instanceof NotFoundError) return { records: [], cursor: null };
      throw unavailable(err);
    }
  }

  async fundWithFriendbot(address: string): Promise<void> {
    const res = await fetch(
      `https://friendbot.stellar.org/?addr=${encodeURIComponent(address)}`,
    );
    if (!res.ok && res.status !== 400)
      throw new LedgerUnavailableError(`Friendbot answered ${res.status}`);
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

const PAYMENT_TYPES = new Set([
  'payment',
  'path_payment_strict_receive',
  'path_payment_strict_send',
]);

interface HorizonPaymentRecord {
  id: string;
  paging_token: string;
  type: string;
  transaction_hash: string;
  transaction_successful?: boolean;
  created_at: string;
  from?: string;
  to?: string;
  amount?: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  transaction_attr?: { ledger_attr?: number; ledger?: number; memo?: string; memo_type?: string };
}

const unavailable = (err: unknown) =>
  new LedgerUnavailableError(
    `Horizon request failed: ${(err as Error).message}`,
    {
      cause: err,
    },
  );
