import { Keypair } from '@stellar/stellar-sdk';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp, fakeChain, freshIp } from './helpers.js';

const USDC = 'USDC:GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57';

describe('Stellar endpoints and API shape (e2e)', () => {
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(() => app.close());

  it('describes the network without a token', async () => {
    const res = await http()
      .get('/api/v1/stellar/network')
      .set('X-Forwarded-For', freshIp())
      .expect(200);
    expect(res.body.data).toEqual({
      network: 'testnet',
      networkPassphrase: 'Test SDF Network ; September 2015',
      horizonUrl: 'https://horizon-testnet.stellar.org',
      explorerUrl: 'https://stellar.expert/explorer/testnet',
      assets: [
        {
          id: USDC,
          code: 'USDC',
          issuer: USDC.split(':')[1],
          native: false,
        },
      ],
      platformAccount: expect.stringMatching(/^G[A-Z2-7]{55}$/),
    });
  });

  it('looks up an account: balances, trustlines and unfunded addresses', async () => {
    const funded = Keypair.random().publicKey();
    fakeChain.set(funded, {
      address: funded,
      sequence: '1',
      balances: [{ assetId: 'XLM', balance: '100.0000000', limit: null }],
    });
    const res = await http()
      .get(`/api/v1/stellar/accounts/${funded}`)
      .set('X-Forwarded-For', freshIp())
      .expect(200);
    expect(res.body.data).toMatchObject({
      address: funded,
      exists: true,
      assets: [
        { id: USDC, trusted: false, balance: null },
      ],
    });

    const unfunded = Keypair.random().publicKey();
    const missing = await http()
      .get(`/api/v1/stellar/accounts/${unfunded}`)
      .set('X-Forwarded-For', freshIp())
      .expect(200);
    expect(missing.body.data.exists).toBe(false);
  });

  it.each(['not-an-address', Keypair.random().secret()])(
    'rejects %s with 400',
    async (address) => {
      const res = await http()
        .get(`/api/v1/stellar/accounts/${address}`)
        .set('X-Forwarded-For', freshIp())
        .expect(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
    },
  );

  it('serves routes only under /api/v1, with /health left bare', async () => {
    await http()
      .get('/v1/stellar/network')
      .set('X-Forwarded-For', freshIp())
      .expect(404);
    await http()
      .get('/api/v1/health')
      .set('X-Forwarded-For', freshIp())
      .expect(404);
    const health = await http()
      .get('/health')
      .set('X-Forwarded-For', freshIp());
    expect([200, 503]).toContain(health.status);
  });

  it('allows CORS from configured origins only', async () => {
    const allowed = await http()
      .options('/api/v1/auth/login')
      .set('Origin', 'https://fysi.test')
      .set('Access-Control-Request-Method', 'POST');
    expect(allowed.headers['access-control-allow-origin']).toBe(
      'https://fysi.test',
    );
    const local = await http()
      .get('/api/v1/stellar/network')
      .set('Origin', 'http://localhost:5173');
    expect(local.headers['access-control-allow-origin']).toBe(
      'http://localhost:5173',
    );
    const other = await http()
      .get('/api/v1/stellar/network')
      .set('Origin', 'https://evil.example');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });
});
