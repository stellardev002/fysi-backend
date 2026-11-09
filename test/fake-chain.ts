import {
  Account,
  type FeeBumpTransaction,
  Keypair,
  Memo,
  Networks,
  Operation,
  type Transaction,
  TransactionBuilder,
  Asset,
} from '@stellar/stellar-sdk';
import { fromStroops, toStroops } from '../src/stellar/amounts.js';
import {
  type LedgerAccount,
  type LedgerPayment,
  type LedgerTransaction,
  LedgerUnavailableError,
  type PaymentsPage,
  StellarLedger,
  type SubmitOutcome,
} from '../src/stellar/ledger.js';

export const USDC_ISSUER = 'GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57';
export const USDC_ID = `USDC:${USDC_ISSUER}`;
const USDC = new Asset('USDC', USDC_ISSUER);

interface FakeAccount {
  sequence: bigint;
  lines: Map<string, bigint>; // assetId -> stroops ('XLM' included)
}

/**
 * An in-memory Stellar for e2e tests: enough of the protocol to exercise the
 * platform for real — sequence numbers, signature checks (including fee bumps
 * and operation sources), sponsored account creation, trustlines, payments
 * with memos, and paged payment history. Paging tokens and operation ids keep
 * growing across test files, as they do on the real network.
 */
class Chain {
  accounts = new Map<string, FakeAccount>();
  payments: LedgerPayment[] = [];
  transactions = new Map<string, { successful: boolean; ledger: number }>();
  ledger = 1000;
  private counter = BigInt(Date.now()) * 1000n;
  /** 'apply' normally; 'timeout' fails before applying; 'lose-response' applies then fails. */
  mode: 'apply' | 'timeout' | 'lose-response' = 'apply';

  nextId() {
    return (++this.counter).toString();
  }

  /** Test helper: an outside wallet with XLM, a USDC trustline and `usdc` dollars. */
  externalWallet(usdc = '0'): Keypair {
    const kp = Keypair.random();
    this.accounts.set(kp.publicKey(), {
      sequence: 1n,
      lines: new Map([
        ['XLM', toStroops('100')],
        [USDC_ID, toStroops(usdc)],
      ]),
    });
    return kp;
  }

  /** Test helper: credits USDC to an existing trustline (a faucet or an exchange deposit). */
  credit(address: string, usdc: string) {
    const a = this.accounts.get(address);
    if (!a?.lines.has(USDC_ID)) throw new Error(`${address} has no USDC trustline`);
    a.lines.set(USDC_ID, a.lines.get(USDC_ID)! + toStroops(usdc));
    this.payments.push({
      id: this.nextId(),
      pagingToken: this.nextId(),
      txHash: Buffer.from(this.nextId()).toString('hex').padEnd(64, '0').slice(0, 64),
      ledger: ++this.ledger,
      closedAt: new Date(),
      from: USDC_ISSUER,
      to: address,
      assetId: USDC_ID,
      amount: usdc,
      memo: null,
      successful: true,
    });
  }

  usdc(address: string): string {
    return fromStroops(this.accounts.get(address)?.lines.get(USDC_ID) ?? 0n);
  }

  /** Test helper: what a customer's own wallet does when paying a QR code or link. */
  pay(from: Keypair, p: { destination: string; amount: string; memo?: string; asset?: Asset }) {
    const acc = this.accounts.get(from.publicKey())!;
    let builder = new TransactionBuilder(
      new Account(from.publicKey(), acc.sequence.toString()),
      { fee: '100', networkPassphrase: Networks.TESTNET },
    )
      .addOperation(Operation.payment({ destination: p.destination, asset: p.asset ?? USDC, amount: p.amount }))
      .setTimeout(300);
    if (p.memo) builder = builder.addMemo(Memo.text(p.memo));
    const tx = builder.build();
    tx.sign(from);
    return this.apply(tx.toEnvelope().toXDR('base64'), Networks.TESTNET);
  }

  apply(xdr: string, passphrase: string): SubmitOutcome {
    const parsed = TransactionBuilder.fromXDR(xdr, passphrase);
    const outer = parsed;
    const tx: Transaction = 'innerTransaction' in parsed ? parsed.innerTransaction : parsed;
    const hash = Buffer.from(outer.hash()).toString('hex');
    if (this.transactions.has(hash)) return { kind: 'failed', codes: ['tx_bad_seq'] };

    const signed = (key: string, t: Transaction | FeeBumpTransaction) =>
      t.signatures.some((s) => Keypair.fromPublicKey(key).verify(Buffer.from(t.hash()), s.signature));
    if ('innerTransaction' in parsed && !signed(parsed.feeSource, parsed))
      return { kind: 'failed', codes: ['tx_bad_auth'] };
    const max = Number(tx.timeBounds?.maxTime ?? 0);
    if (max && max < Math.floor(Date.now() / 1000)) return { kind: 'failed', codes: ['tx_too_late'] };
    const source = this.accounts.get(tx.source);
    if (!source) return { kind: 'failed', codes: ['tx_no_source_account'] };
    if (BigInt(tx.sequence) !== source.sequence + 1n) return { kind: 'failed', codes: ['tx_bad_seq'] };
    const signers = new Set([tx.source, ...tx.operations.map((o) => o.source).filter((s): s is string => !!s)]);
    for (const key of signers) if (!signed(key, tx)) return { kind: 'failed', codes: ['tx_bad_auth'] };

    // Apply on copies so a failing operation changes nothing.
    const draft = new Map([...this.accounts].map(([k, v]) => [k, { sequence: v.sequence, lines: new Map(v.lines) }]));
    draft.get(tx.source)!.sequence += 1n;
    const records: LedgerPayment[] = [];
    const memo = tx.memo.type === 'text' ? Buffer.from(tx.memo.value as Uint8Array).toString() : null;
    for (const op of tx.operations) {
      const opSource = op.source ?? tx.source;
      const fail = (code: string): SubmitOutcome => {
        this.accounts.get(tx.source)!.sequence += 1n; // a failed transaction still uses its sequence
        this.transactions.set(hash, { successful: false, ledger: ++this.ledger });
        return { kind: 'failed', codes: ['tx_failed', code] };
      };
      switch (op.type) {
        case 'beginSponsoringFutureReserves':
        case 'endSponsoringFutureReserves':
          break;
        case 'createAccount':
          if (draft.has(op.destination)) return fail('op_already_exists');
          draft.set(op.destination, { sequence: 1n, lines: new Map([['XLM', toStroops(op.startingBalance)]]) });
          break;
        case 'changeTrust': {
          const a = draft.get(opSource);
          if (!a) return fail('op_no_account');
          const asset = op.line as Asset;
          const id = `${asset.getCode()}:${asset.getIssuer()}`;
          if (!a.lines.has(id)) a.lines.set(id, 0n);
          break;
        }
        case 'payment': {
          const asset = op.asset;
          const id = asset.isNative() ? 'XLM' : `${asset.getCode()}:${asset.getIssuer()}`;
          const from = draft.get(opSource)!;
          const to = draft.get(op.destination);
          const amount = toStroops(op.amount);
          if (!from.lines.has(id)) return fail('op_src_no_trust');
          if (!to) return fail('op_no_destination');
          if (!to.lines.has(id)) return fail('op_no_trust');
          if (from.lines.get(id)! < amount) return fail('op_underfunded');
          from.lines.set(id, from.lines.get(id)! - amount);
          to.lines.set(id, to.lines.get(id)! + amount);
          records.push({
            id: this.nextId(),
            pagingToken: '',
            txHash: hash,
            ledger: 0,
            closedAt: new Date(),
            from: opSource,
            to: op.destination,
            assetId: id,
            amount: fromStroops(amount),
            memo,
            successful: true,
          });
          break;
        }
        default:
          return fail('op_not_supported');
      }
    }
    this.accounts = draft;
    const ledger = ++this.ledger;
    this.transactions.set(hash, { successful: true, ledger });
    if ('innerTransaction' in parsed)
      this.transactions.set(Buffer.from(tx.hash()).toString('hex'), { successful: true, ledger });
    for (const r of records) this.payments.push({ ...r, ledger, pagingToken: this.nextId() });
    return { kind: 'success', ledger };
  }
}

export const chain = new Chain();

export class FakeLedger extends StellarLedger {
  loadAccount(address: string): Promise<LedgerAccount | null> {
    const a = chain.accounts.get(address);
    if (!a) return Promise.resolve(null);
    return Promise.resolve({
      address,
      sequence: a.sequence.toString(),
      balances: [...a.lines].map(([assetId, v]) => ({
        assetId,
        balance: fromStroops(v),
        limit: assetId === 'XLM' ? null : '922337203685.4775807',
      })),
    });
  }

  baseFee() {
    return Promise.resolve(100);
  }

  submit(xdr: string, passphrase: string): Promise<SubmitOutcome> {
    if (chain.mode === 'timeout') return Promise.reject(new LedgerUnavailableError('timeout'));
    const outcome = chain.apply(xdr, passphrase);
    if (chain.mode === 'lose-response')
      return Promise.reject(new LedgerUnavailableError('response lost'));
    return Promise.resolve(outcome);
  }

  findTransaction(hash: string): Promise<LedgerTransaction> {
    const t = chain.transactions.get(hash);
    return Promise.resolve(
      t ? { found: true, successful: t.successful, ledger: t.ledger, closedAt: new Date() } : { found: false },
    );
  }

  paymentsFor(
    address: string,
    opts: { cursor?: string; limit: number; order?: 'asc' | 'desc' },
  ): Promise<PaymentsPage> {
    let list = chain.payments.filter((p) => p.from === address || p.to === address);
    if (opts.order === 'desc') list = [...list].reverse();
    if (opts.cursor) {
      const c = BigInt(opts.cursor);
      list = list.filter((p) => (opts.order === 'desc' ? BigInt(p.pagingToken) < c : BigInt(p.pagingToken) > c));
    }
    const records = list.slice(0, opts.limit);
    return Promise.resolve({ records, cursor: records.at(-1)?.pagingToken ?? null });
  }

  fundWithFriendbot(address: string): Promise<void> {
    if (!chain.accounts.has(address))
      chain.accounts.set(address, { sequence: 1n, lines: new Map([['XLM', toStroops('10000')]]) });
    return Promise.resolve();
  }
}
