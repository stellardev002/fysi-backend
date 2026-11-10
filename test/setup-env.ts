import { Keypair } from '@stellar/stellar-sdk';

// Runs before every e2e file. DATABASE_URL and REDIS_URL must point at
// disposable instances: tests create users and audit rows.
for (const name of ['DATABASE_URL', 'REDIS_URL']) {
  if (!process.env[name]) throw new Error(`${name} is required for e2e tests`);
}
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.TRUST_PROXY_HOPS = '1';
process.env.JWT_ACCESS_SECRET ??= 'e2e-secret-e2e-secret-e2e-secret-e2e';
process.env.CORS_ORIGINS = 'http://localhost:5173';
process.env.FRONTEND_URL = 'https://fysi.test/';
process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.MFA_REQUIRED_ROLES = '';
process.env.STELLAR_NETWORK = 'testnet';
process.env.STELLAR_ASSETS =
  'USDC:GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57';
// A throwaway platform key per run.
process.env.STELLAR_PLATFORM_SECRET = Keypair.random().secret();
// Tests drive the watcher and sweeper themselves (helpers.tick).
process.env.WATCHER_INTERVAL_MS = '0';
process.env.SWEEP_INTERVAL_SECONDS = '0';
process.env.WALLET_PROVIDER = 'local';
