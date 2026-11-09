import { randomBytes } from 'node:crypto';
import {
  Account,
  type FeeBumpTransaction,
  Memo,
  Operation,
  type Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { type AllowedAsset, toSdkAsset } from './assets.js';
import { fromStroops } from './amounts.js';

export interface SourceAccount {
  address: string;
  sequence: string;
}

export interface TxContext {
  /** Stroops per operation. */
  fee: number;
  networkPassphrase: string;
  /** The transaction cannot land after this many seconds. */
  ttlSeconds: number;
  now?: number;
}

const builder = (source: SourceAccount, ctx: TxContext) =>
  new TransactionBuilder(new Account(source.address, source.sequence), {
    fee: String(ctx.fee),
    networkPassphrase: ctx.networkPassphrase,
    timebounds: {
      minTime: 0,
      maxTime: Math.floor((ctx.now ?? Date.now()) / 1000) + ctx.ttlSeconds,
    },
  });

export const txHash = (tx: Transaction | FeeBumpTransaction): string =>
  Buffer.from(tx.hash()).toString('hex');

export const txExpiry = (tx: Transaction): Date =>
  new Date(Number(tx.timeBounds?.maxTime ?? 0) * 1000);

/**
 * Opens a custodial account whose reserves the sponsor pays (PRD: Fysi
 * sponsors the XLM reserve), with a trustline for the settlement asset.
 * Needs signatures from the sponsor and from the new account.
 */
export function buildActivation(
  sponsor: SourceAccount,
  newAccount: string,
  asset: AllowedAsset,
  ctx: TxContext,
): Transaction {
  return builder(sponsor, ctx)
    .addOperation(
      Operation.beginSponsoringFutureReserves({ sponsoredId: newAccount }),
    )
    .addOperation(
      Operation.createAccount({ destination: newAccount, startingBalance: '0' }),
    )
    .addOperation(
      Operation.changeTrust({ asset: toSdkAsset(asset), source: newAccount }),
    )
    .addOperation(Operation.endSponsoringFutureReserves({ source: newAccount }))
    .build();
}

/** One payment with a text memo. */
export function buildPayment(
  source: SourceAccount,
  p: { destination: string; asset: AllowedAsset; amount: bigint; memo: string },
  ctx: TxContext,
): Transaction {
  return builder(source, ctx)
    .addOperation(
      Operation.payment({
        destination: p.destination,
        asset: toSdkAsset(p.asset),
        amount: fromStroops(p.amount),
      }),
    )
    .addMemo(Memo.text(p.memo))
    .build();
}

/** The platform pays the fee, so custodial wallets never need XLM. */
export const feeBump = (
  inner: Transaction,
  feeSource: string,
  ctx: Pick<TxContext, 'fee' | 'networkPassphrase'>,
): FeeBumpTransaction =>
  TransactionBuilder.buildFeeBumpTransaction(
    feeSource,
    String(ctx.fee),
    inner,
    ctx.networkPassphrase,
  );

/** A memo up to Stellar's 28-byte text limit: prefix plus random characters. */
export const newMemo = (prefix: string, length = 10): string => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return (
    prefix +
    Array.from(randomBytes(length), (b) => alphabet[b % alphabet.length]).join('')
  );
};

export class SignedPaymentMismatchError extends Error {}

/**
 * Parses a wallet-signed transaction and checks it is exactly the payment that
 * was built (the hash covers every field and the network). Returns the XDR.
 */
export function checkSignedPayment(
  signedXdr: string,
  expectedHash: string,
  networkPassphrase: string,
): string {
  let tx;
  try {
    tx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
  } catch {
    throw new SignedPaymentMismatchError('That is not a valid signed transaction');
  }
  if ('innerTransaction' in tx)
    throw new SignedPaymentMismatchError('Fee-bump transactions are not accepted here');
  if (txHash(tx) !== expectedHash)
    throw new SignedPaymentMismatchError(
      'This is not the payment that was prepared (it was changed, or signed for another network). Prepare it again',
    );
  if (tx.signatures.length === 0)
    throw new SignedPaymentMismatchError('The transaction is not signed');
  return signedXdr;
}

/** Stellar result codes → a sentence a person can act on. */
export function explainFailure(codes: string[], assetCode: string): string {
  const has = (c: string) => codes.includes(c);
  if (has('tx_too_late')) return 'The payment expired before it reached the network. Try again';
  if (has('op_underfunded')) return `Not enough ${assetCode} in the wallet for this amount`;
  if (has('tx_insufficient_balance'))
    return 'Not enough XLM in the wallet to cover the network fee and minimum balance';
  if (has('op_src_no_trust'))
    return `The wallet cannot hold ${assetCode}: add the ${assetCode} trustline first`;
  if (has('op_no_trust')) return `The receiving account cannot hold ${assetCode}`;
  if (has('op_no_destination')) return 'The receiving account does not exist on the network';
  if (has('op_line_full')) return `The receiving account cannot hold any more ${assetCode}`;
  if (has('tx_bad_seq'))
    return 'The wallet sent another transaction in the meantime. Try again';
  if (has('tx_bad_auth') || has('tx_bad_auth_extra'))
    return 'The payment was not signed by the paying wallet';
  if (has('tx_insufficient_fee')) return 'The network is busy and the fee was too low. Try again';
  if (has('tx_no_source_account'))
    return 'The paying wallet does not exist on the network yet: fund it first';
  return `The network rejected the payment (${codes.join(', ')})`;
}

/**
 * SEP-7 payment request (`web+stellar:pay`), for the checkout QR code and the
 * pay page (PRD: scan QR, payment link). Any SEP-7 wallet pre-fills destination,
 * amount, asset and memo, so the payment matches the order.
 */
export function sep7PayUri(p: {
  destination: string;
  amount: bigint;
  asset: AllowedAsset;
  memo: string;
  message?: string;
  /** Only for non-public networks; wallets assume mainnet without it. */
  networkPassphrase?: string;
}): string {
  const params = new URLSearchParams({ destination: p.destination, amount: fromStroops(p.amount) });
  if (!p.asset.native) {
    params.set('asset_code', p.asset.code);
    params.set('asset_issuer', p.asset.issuer!);
  }
  params.set('memo', p.memo);
  params.set('memo_type', 'MEMO_TEXT');
  if (p.message) params.set('msg', p.message.slice(0, 300));
  if (p.networkPassphrase) params.set('network_passphrase', p.networkPassphrase);
  // SEP-7 values are percent-encoded; URLSearchParams uses + for spaces.
  return `web+stellar:pay?${params.toString().replace(/\+/g, '%20')}`;
}
