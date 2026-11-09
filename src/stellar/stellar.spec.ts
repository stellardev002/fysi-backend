import {
  Account,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { StellarNetwork } from '../config/env.validation.js';
import { isAccountAddress, shortAddress } from './address.js';
import { fromStroops, isStellarAmount, toStroops } from './amounts.js';
import { parseAsset, parseAssetList } from './assets.js';
import {
  type LedgerAccount,
  LedgerUnavailableError,
  StellarLedger,
} from './ledger.js';
import { KeypairSigner, UnconfiguredSigner } from './signer.js';
import { StellarAccountsService } from './stellar-accounts.service.js';
import { StellarConfig } from './stellar.config.js';

const issuer = Keypair.random().publicKey();
const holder = Keypair.random().publicKey();

const env = (
  over: Partial<ConstructorParameters<typeof StellarConfig>[0]> = {},
) => ({
  STELLAR_NETWORK: StellarNetwork.Testnet,
  STELLAR_ALLOW_MAINNET: false,
  STELLAR_HORIZON_URL: '',
  STELLAR_ASSETS: 'XLM',
  ...over,
});

describe('amounts', () => {
  it('converts exactly, without floats', () => {
    expect(toStroops('1')).toBe(10_000_000n);
    expect(toStroops('0.1')).toBe(1_000_000n);
    expect(toStroops('0.0000001')).toBe(1n);
    expect(toStroops('922337203685.4775807')).toBe(2n ** 63n - 1n);
    // 0.1 + 0.2 is 0.30000000000000004 in floats; in stroops it is exact.
    expect(fromStroops(toStroops('0.1') + toStroops('0.2'))).toBe('0.3');
    expect(fromStroops(15_000_000n)).toBe('1.5');
    expect(fromStroops(0n)).toBe('0');
  });

  it.each([
    '',
    '-1',
    '1.12345678',
    '1e5',
    '0x10',
    ' ',
    '1,5',
    '922337203685.4775808',
  ])('rejects %j', (value) => {
    expect(() => toStroops(value)).toThrow();
    expect(isStellarAmount(value)).toBe(false);
  });

  it('treats zero as not a payable amount', () => {
    expect(isStellarAmount('0')).toBe(false);
    expect(isStellarAmount('0.0000001')).toBe(true);
  });
});

describe('addresses', () => {
  it('accepts a G address and rejects everything else', () => {
    expect(isAccountAddress(holder)).toBe(true);
    expect(isAccountAddress(holder.toLowerCase())).toBe(false);
    // One changed character breaks the checksum.
    const typo = holder.endsWith('A') ? 'B' : 'A';
    expect(isAccountAddress(`${holder.slice(0, -1)}${typo}`)).toBe(false);
    expect(isAccountAddress(Keypair.random().secret())).toBe(false);
    expect(isAccountAddress('')).toBe(false);
    expect(isAccountAddress(42)).toBe(false);
  });

  it('shortens for display', () => {
    expect(shortAddress(holder)).toBe(
      `${holder.slice(0, 4)}…${holder.slice(-4)}`,
    );
  });
});

describe('assets', () => {
  it('parses XLM and CODE:ISSUER', () => {
    expect(parseAsset('xlm')).toEqual({
      id: 'XLM',
      code: 'XLM',
      issuer: null,
      native: true,
    });
    expect(parseAsset(` USDC:${issuer} `)).toEqual({
      id: `USDC:${issuer}`,
      code: 'USDC',
      issuer,
      native: false,
    });
  });

  it.each([
    'USDC',
    `USDC:${issuer}:x`,
    `TOO-LONG-CODE1:${issuer}`,
    'USDC:GBAD',
  ])('rejects %s', (entry) => expect(() => parseAsset(entry)).toThrow());

  it('rejects duplicates and empty lists', () => {
    expect(() => parseAssetList('XLM,native')).toThrow(/twice/);
    expect(() => parseAssetList(' , ')).toThrow(/no assets/);
    expect(parseAssetList(`XLM,USDC:${issuer}`)).toHaveLength(2);
  });
});

describe('StellarConfig', () => {
  it('derives testnet settings', () => {
    const c = new StellarConfig(env());
    expect(c.networkPassphrase).toBe(Networks.TESTNET);
    expect(c.horizonUrl).toBe('https://horizon-testnet.stellar.org');
    expect(c.transactionUrl('abc')).toBe(
      'https://stellar.expert/explorer/testnet/tx/abc',
    );
  });

  it('refuses mainnet without the explicit switch', () => {
    expect(
      () => new StellarConfig(env({ STELLAR_NETWORK: StellarNetwork.Mainnet })),
    ).toThrow(/STELLAR_ALLOW_MAINNET/);
    const c = new StellarConfig(
      env({
        STELLAR_NETWORK: StellarNetwork.Mainnet,
        STELLAR_ALLOW_MAINNET: true,
      }),
    );
    expect(c.networkPassphrase).toBe(Networks.PUBLIC);
    expect(c.horizonUrl).toBe('https://horizon.stellar.org');
  });

  it('honours a custom Horizon URL', () => {
    const c = new StellarConfig(
      env({ STELLAR_HORIZON_URL: 'https://h.example/' }),
    );
    expect(c.horizonUrl).toBe('https://h.example');
  });
});

describe('PlatformSigner', () => {
  it('signs with the configured key and never reveals the secret', () => {
    const kp = Keypair.random();
    const signer = new KeypairSigner(kp.secret());
    expect(signer.publicKey()).toBe(kp.publicKey());
    const tx = new TransactionBuilder(new Account(kp.publicKey(), '1'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.bumpSequence({ bumpTo: '2' }))
      .setTimeout(30)
      .build();
    signer.sign(tx);
    expect(kp.verify(tx.hash(), tx.signatures[0].signature)).toBe(true);
    expect(JSON.stringify(signer)).not.toContain(kp.secret());
  });

  it('rejects a bad secret without echoing it', () => {
    expect(() => new KeypairSigner('SNOTAREALSECRET')).toThrow(
      /^STELLAR_PLATFORM_SECRET is not a valid Stellar secret key$/,
    );
  });

  it('refuses to sign when unconfigured', () => {
    const signer = new UnconfiguredSigner();
    expect(signer.configured).toBe(false);
    expect(() => signer.publicKey()).toThrow(/platform signing is disabled/);
  });
});

class FakeLedger extends StellarLedger {
  constructor(private readonly result: LedgerAccount | null | Error) {
    super();
  }
  loadAccount(): Promise<LedgerAccount | null> {
    return this.result instanceof Error
      ? Promise.reject(this.result)
      : Promise.resolve(this.result);
  }
  baseFee() {
    return Promise.resolve(100);
  }
  submit() {
    return Promise.resolve({ kind: 'success' as const, ledger: 1 });
  }
  findTransaction() {
    return Promise.resolve({ found: false as const });
  }
}

describe('StellarAccountsService', () => {
  const config = new StellarConfig(
    env({ STELLAR_ASSETS: `XLM,USDC:${issuer}` }),
  );
  const service = (ledger: StellarLedger) =>
    new StellarAccountsService(config, ledger, new UnconfiguredSigner());

  it('reports balances and missing trustlines per accepted asset', async () => {
    const summary = await service(
      new FakeLedger({
        address: holder,
        sequence: '1',
        balances: [{ assetId: 'XLM', balance: '25.5000000', limit: null }],
      }),
    ).describe(holder);
    expect(summary).toMatchObject({
      exists: true,
      shortAddress: shortAddress(holder),
    });
    expect(summary.assets).toEqual([
      expect.objectContaining({
        id: 'XLM',
        trusted: true,
        balance: '25.5000000',
      }),
      expect.objectContaining({ code: 'USDC', trusted: false, balance: null }),
    ]);
  });

  it('reports an unfunded account as not existing', async () => {
    const summary = await service(new FakeLedger(null)).describe(holder);
    expect(summary.exists).toBe(false);
    expect(summary.assets.every((a) => !a.trusted)).toBe(true);
  });

  it('maps bad input to 400 and Horizon outages to 503', async () => {
    await expect(
      service(new FakeLedger(null)).describe('nope'),
    ).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      service(new FakeLedger(new LedgerUnavailableError('down'))).describe(
        holder,
      ),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('describes the network without a platform account when unconfigured', () => {
    expect(service(new FakeLedger(null)).networkInfo()).toMatchObject({
      network: 'testnet',
      networkPassphrase: Networks.TESTNET,
      platformAccount: null,
      assets: [{ id: 'XLM' }, { code: 'USDC', issuer }],
    });
  });
});
