import { Keypair, Networks, type Operation } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { parseAsset } from './assets.js';
import {
  buildActivation,
  buildPayment,
  checkSignedPayment,
  explainFailure,
  feeBump,
  newMemo,
  sep7PayUri,
  SignedPaymentMismatchError,
  txHash,
} from './transactions.js';

const issuer = Keypair.random().publicKey();
const USDC = parseAsset(`USDC:${issuer}`);
const ctx = { fee: 100, networkPassphrase: Networks.TESTNET, ttlSeconds: 300 };

describe('transaction builders', () => {
  it('builds a sponsored activation with a USDC trustline', () => {
    const sponsor = Keypair.random();
    const fresh = Keypair.random();
    const tx = buildActivation(
      { address: sponsor.publicKey(), sequence: '10' },
      fresh.publicKey(),
      USDC,
      ctx,
    );
    expect(tx.operations.map((o) => o.type)).toEqual([
      'beginSponsoringFutureReserves',
      'createAccount',
      'changeTrust',
      'endSponsoringFutureReserves',
    ]);
    expect((tx.operations[1] as Operation.CreateAccount).startingBalance).toBe('0.0000000');
    expect(tx.operations[2].source).toBe(fresh.publicKey());
  });

  it('builds an exact payment, and the fee bump keeps the inner hash', () => {
    const payer = Keypair.random();
    const platform = Keypair.random();
    const inner = buildPayment(
      { address: payer.publicKey(), sequence: '1' },
      { destination: platform.publicKey(), asset: USDC, amount: 125_000_000n, memo: 'FYABC' },
      ctx,
    );
    const op = inner.operations[0] as Operation.Payment;
    expect(op.amount).toBe('12.5000000');
    expect(Buffer.from(inner.memo.value as Uint8Array).toString()).toBe('FYABC');
    inner.sign(payer);
    const bumped = feeBump(inner, platform.publicKey(), ctx);
    expect(bumped.feeSource).toBe(platform.publicKey());
    expect(txHash(bumped.innerTransaction)).toBe(txHash(inner));
  });

  it('accepts only the exact prepared payment, signed', () => {
    const payer = Keypair.random();
    const tx = buildPayment(
      { address: payer.publicKey(), sequence: '1' },
      { destination: Keypair.random().publicKey(), asset: USDC, amount: 1n, memo: 'FYX' },
      ctx,
    );
    const hash = txHash(tx);
    const unsigned = tx.toEnvelope().toXDR('base64');
    expect(() => checkSignedPayment(unsigned, hash, Networks.TESTNET)).toThrow(/not signed/);
    tx.sign(payer);
    const signed = tx.toEnvelope().toXDR('base64');
    expect(checkSignedPayment(signed, hash, Networks.TESTNET)).toBe(signed);
    expect(() => checkSignedPayment(signed, 'ff'.repeat(32), Networks.TESTNET)).toThrow(
      SignedPaymentMismatchError,
    );
    expect(() => checkSignedPayment(signed, hash, Networks.PUBLIC)).toThrow(
      SignedPaymentMismatchError,
    );
    expect(() => checkSignedPayment('garbage', hash, Networks.TESTNET)).toThrow(/not a valid/);
  });

  it('explains network failures in plain words', () => {
    expect(explainFailure(['tx_failed', 'op_underfunded'], 'USDC')).toBe(
      'Not enough USDC in the wallet for this amount',
    );
    expect(explainFailure(['weird'], 'USDC')).toMatch(/rejected the payment \(weird\)/);
  });

  it('makes short memos that fit a text memo', () => {
    const memo = newMemo('FY');
    expect(memo).toMatch(/^FY[A-Z2-9]{10}$/);
    expect(Buffer.byteLength(memo)).toBeLessThanOrEqual(28);
  });

  it('encodes a SEP-7 payment request', () => {
    const dest = Keypair.random().publicKey();
    const uri = sep7PayUri({
      destination: dest,
      amount: 125_000_000n,
      asset: USDC,
      memo: 'FYK3M9QXWA',
      message: 'Fysi order FYK3M9QXWA',
      networkPassphrase: Networks.TESTNET,
    });
    const url = new URL(uri);
    expect(url.protocol).toBe('web+stellar:');
    expect(url.pathname).toBe('pay');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      destination: dest,
      amount: '12.5',
      asset_code: 'USDC',
      asset_issuer: issuer,
      memo: 'FYK3M9QXWA',
      memo_type: 'MEMO_TEXT',
      msg: 'Fysi order FYK3M9QXWA',
      network_passphrase: Networks.TESTNET,
    });
    expect(uri.split('?')[1]).not.toContain('+');
  });
});
