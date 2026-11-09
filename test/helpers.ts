import { v7 } from 'uuid';
import { resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { totpCode, totpStep } from '../src/auth/totp.js';
import { runMigrations } from '../src/database/migrator.js';
import { Mailer } from '../src/mail/mailer.js';
import { StellarLedger } from '../src/stellar/ledger.js';
import { WalletsService } from '../src/wallets/wallets.service.js';
import { PaymentsScheduler } from '../src/payments/scheduler.js';
import { PaymentWatcher } from '../src/payments/watcher.service.js';
import { FakeLedger } from './fake-chain.js';
import { ObjectStorage } from '../src/storage/object-storage.js';

/** Latest code mailed to each address, and every subject sent to it. */
export const mailbox = new Map<string, string>();
export const sentSubjects = new Map<string, string[]>();

class CapturingMailer extends Mailer {
  send(message: { to: string; subject: string; text: string }): Promise<void> {
    const code = /code is (\d{6})/.exec(message.text)?.[1];
    if (code) mailbox.set(message.to, code);
    sentSubjects.set(message.to, [
      ...(sentSubjects.get(message.to) ?? []),
      message.subject,
    ]);
    return Promise.resolve();
  }
}

/** In-memory bucket that records what the API uploaded. */
export const fakeBucket = new Map<
  string,
  { sizeBytes: number; contentType: string }
>();

class FakeStorage extends ObjectStorage {
  put(key: string, body: Buffer, contentType: string) {
    fakeBucket.set(key, { sizeBytes: body.length, contentType });
    return Promise.resolve();
  }
  presignDownload(key: string) {
    return Promise.resolve(`https://bucket.test/${key}?sig=get`);
  }
  delete(keys: string[]) {
    for (const k of keys) fakeBucket.delete(k);
    return Promise.resolve();
  }
}

/** Smallest bytes that pass the image signature check. */
export const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);
/** Smallest bytes that pass the PDF signature check. */
export const PDF_BYTES = Buffer.from('%PDF-1.7\n%test\n');

export async function createTestApp(): Promise<NestExpressApplication> {
  await runMigrations(process.env.DATABASE_URL!, resolve('drizzle'));
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(Mailer)
    .useClass(CapturingMailer)
    .overrideProvider(StellarLedger)
    .useClass(FakeLedger)
    .overrideProvider(ObjectStorage)
    .useClass(FakeStorage)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bufferLogs: true,
  });
  configureApp(app);
  await app.init();
  return app;
}

export const createPool = () =>
  new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

let ipCounter = 0;
/** Unique client IP per call so rate-limit buckets do not leak between tests. */
export const freshIp = () =>
  `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter++ & 255}`;

export const uniqueEmail = () => `user-${v7()}@example.test`;
export const PASSWORD = 'correct-horse-battery';

/**
 * A code the API will accept now: each step works once per account, so this
 * moves to the next step after one is used (the window allows one step ahead).
 */
const lastStepUsed = new Map<string, number>();
export function freshTotp(secret: string): string {
  const step = Math.max(totpStep(), (lastStepUsed.get(secret) ?? -1) + 1);
  if (step > totpStep() + 1)
    throw new Error('Test used 2FA too often for one account in 30 seconds');
  lastStepUsed.set(secret, step);
  return totpCode(secret, step);
}

export interface Session {
  email: string;
  accessToken: string;
  refreshToken: string;
  userId: string;
  /** Base32 TOTP secret when 2FA is on. */
  totpSecret?: string;
}

/**
 * Request builder. Resolve every value before calling it: supertest closes its
 * shared server when nothing is pending, so an `await` between building a
 * request and sending it can leave the request with no server.
 */
export const api = (app: NestExpressApplication) => {
  const server = app.getHttpServer();
  return (
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    path: string,
    token?: string,
  ) => {
    const req = request(server)[method](path).set('X-Forwarded-For', freshIp());
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };
};

export async function registerUser(
  app: NestExpressApplication,
  accountType: 'customer' | 'vendor' = 'customer',
  extra: Record<string, unknown> = {},
): Promise<Session> {
  const call = api(app);
  const email = uniqueEmail();
  await call('post', '/api/v1/auth/register')
    .send({ accountType, name: 'Grace Ajayi', email, password: PASSWORD, ...extra })
    .expect(201);
  const res = await call('post', '/api/v1/auth/verify-email')
    .send({ email, otp: mailbox.get(email) })
    .expect(200);
  const me = await call('get', '/api/v1/auth/me', res.body.data.accessToken).expect(200);
  return {
    email,
    accessToken: res.body.data.accessToken,
    refreshToken: res.body.data.refreshToken,
    userId: me.body.data.id,
  };
}

export const registerCustomer = (app: NestExpressApplication) =>
  registerUser(app, 'customer');

/** Turns 2FA on for a signed-in session and returns the new 2FA session. */
export async function enableTwoFactor(
  app: NestExpressApplication,
  session: Session,
): Promise<Session> {
  const call = api(app);
  const setup = await call('post', '/api/v1/auth/2fa/setup', session.accessToken).expect(200);
  const secret: string = setup.body.data.secret;
  const enabled = await call('post', '/api/v1/auth/2fa/enable', session.accessToken)
    .send({ code: freshTotp(secret) })
    .expect(200);
  return {
    ...session,
    accessToken: enabled.body.data.accessToken,
    refreshToken: enabled.body.data.refreshToken,
    totpSecret: secret,
  };
}

/** A vendor account with 2FA on and an empty draft business. */
export async function registerVendor(app: NestExpressApplication): Promise<Session> {
  return enableTwoFactor(app, await registerUser(app, 'vendor'));
}

/** Promotes a fresh account to admin (or super admin) and turns on 2FA. */
export async function registerAdmin(
  app: NestExpressApplication,
  pool: Pool,
  role: 'admin' | 'super_admin' = 'super_admin',
): Promise<Session> {
  const session = await registerUser(app, 'customer');
  await pool.query(`UPDATE users SET role = $2 WHERE id = $1`, [session.userId, role]);
  const login = await api(app)('post', '/api/v1/auth/login')
    .send({ email: session.email, password: PASSWORD })
    .expect(200);
  return enableTwoFactor(app, {
    ...session,
    accessToken: login.body.data.accessToken,
    refreshToken: login.body.data.refreshToken,
  });
}

export async function categoryId(
  app: NestExpressApplication,
  slug = 'clothing',
): Promise<string> {
  const res = await api(app)('get', '/api/v1/categories').expect(200);
  const found = (res.body.data as { id: string; slug: string }[]).find(
    (c) => c.slug === slug,
  );
  if (!found) throw new Error(`No category ${slug}`);
  return found.id;
}

export const BUSINESS = {
  addressLine: '12 Admiralty Way',
  city: 'Lekki',
  state: 'Lagos',
  phone: '+2348031234567',
  cacNumber: 'RC1234567',
  directorIdType: 'nin',
  directorId: '12345678901',
};

/** Fills the wizard and uploads the CAC certificate plus a GOTS certificate (or evidence). */
export async function completeApplication(
  app: NestExpressApplication,
  vendor: Session,
  opts: { certification?: string | null; businessName?: string } = {},
) {
  const call = api(app);
  const category = await categoryId(app);
  await call('patch', '/api/v1/vendor/profile', vendor.accessToken)
    .send({
      ...BUSINESS,
      businessName: opts.businessName ?? `EcoThreads ${v7().slice(-6)}`,
      categoryId: category,
    })
    .expect(200);
  await call('post', '/api/v1/vendor/documents', vendor.accessToken)
    .field('kind', 'cac_certificate')
    .attach('file', PDF_BYTES, 'cac.pdf')
    .expect(201);
  const cert = opts.certification === undefined ? 'gots' : opts.certification;
  // Build each request only when it is sent: supertest closes its shared
  // server once nothing is pending, which breaks a request made in advance.
  if (cert)
    await call('post', '/api/v1/vendor/documents', vendor.accessToken)
      .field('kind', 'sustainability_certificate')
      .field('certification', cert)
      .attach('file', PDF_BYTES, 'cert.pdf')
      .expect(201);
  else
    await call('post', '/api/v1/vendor/documents', vendor.accessToken)
      .field('kind', 'sustainability_evidence')
      .attach('file', PNG_BYTES, 'workshop.png')
      .expect(201);
}

/** A verified store, ready to list products. */
export async function approvedVendor(
  app: NestExpressApplication,
  admin: Session,
  opts: { certification?: string | null; businessName?: string; founding?: boolean } = {},
): Promise<Session & { slug: string }> {
  const vendor = await registerVendor(app);
  await completeApplication(app, vendor, opts);
  const call = api(app);
  await call('post', '/api/v1/vendor/submit', vendor.accessToken).expect(200);
  const approved = await call(
    'post',
    `/api/v1/admin/vendors/${vendor.userId}/approve`,
    admin.accessToken,
  )
    .send(opts.founding ? { foundingVendor: true } : {})
    .expect(200);
  return { ...vendor, slug: approved.body.data.slug };
}

export async function createProduct(
  app: NestExpressApplication,
  vendor: Session,
  overrides: Record<string, unknown> = {},
) {
  const category = await categoryId(app, 'household');
  const res = await api(app)('post', '/api/v1/vendor/products', vendor.accessToken)
    .send({
      title: 'Organic cotton tote bag',
      description: 'Hand-stitched from GOTS-certified cotton. Holds 15 kg.',
      priceCents: 1250,
      stock: 40,
      categoryId: category,
      certifications: ['gots'],
      ...overrides,
    })
    .expect(201);
  return res.body.data as { id: string; slug: string; [k: string]: unknown };
}

/** Opens the settlement account on the fake chain (Friendbot + USDC trustline). */
export async function setupPayments(app: NestExpressApplication) {
  return app.get(WalletsService).setupSettlement();
}

/** One watcher pass and one sweep, as the scheduler would run them. */
export async function tick(app: NestExpressApplication) {
  await app.get(PaymentWatcher).sync();
  await app.get(PaymentsScheduler).sweep();
}
