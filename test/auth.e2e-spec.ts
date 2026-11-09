import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Pool } from 'pg';
import {
  api,
  createPool,
  createTestApp,
  enableTwoFactor,
  freshTotp,
  mailbox,
  PASSWORD,
  PNG_BYTES,
  registerCustomer,
  registerUser,
  registerVendor,
  uniqueEmail,
} from './helpers.js';

describe('Auth (e2e)', () => {
  let app: NestExpressApplication;
  let pool: Pool;
  let call: ReturnType<typeof api>;

  beforeAll(async () => {
    app = await createTestApp();
    pool = createPool();
    call = api(app);
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  it('signs up a customer by default and returns the account', async () => {
    const email = uniqueEmail();
    const reg = await call('post', '/api/v1/auth/register')
      .send({ name: 'Grace Ajayi', email, password: PASSWORD, phone: '+234 803 123 4567' })
      .expect(201);
    expect(reg.body.data).toMatchObject({ email, accountType: 'customer' });
    const verified = await call('post', '/api/v1/auth/verify-email')
      .send({ email, otp: mailbox.get(email) })
      .expect(200);
    expect(verified.body.data).toMatchObject({
      role: 'customer',
      mfa: false,
      twoFactorSetupRequired: false,
    });
    const me = await call('get', '/api/v1/auth/me', verified.body.data.accessToken).expect(200);
    expect(me.body.data).toMatchObject({
      email,
      role: 'customer',
      phone: '+2348031234567',
      twoFactorEnabled: false,
      twoFactorRequired: false,
      vendor: null,
    });
  });

  it('refuses admin sign-up and sign-in before the email is verified', async () => {
    await call('post', '/api/v1/auth/register')
      .send({ accountType: 'admin', name: 'X', email: uniqueEmail(), password: PASSWORD })
      .expect(400);
    const email = uniqueEmail();
    await call('post', '/api/v1/auth/register')
      .send({ name: 'Tunde', email, password: PASSWORD })
      .expect(201);
    const res = await call('post', '/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(403);
    expect(res.body.message).toBe('Email not verified');
  });

  it('gives a new vendor a draft business and blocks everything until 2FA is on', async () => {
    const vendor = await registerUser(app, 'vendor', { businessName: 'Green Weaves' });
    const me = await call('get', '/api/v1/auth/me', vendor.accessToken).expect(200);
    expect(me.body.data).toMatchObject({
      role: 'vendor',
      twoFactorRequired: true,
      twoFactorEnabled: false,
      vendor: { status: 'draft', businessName: 'Green Weaves', slug: null },
    });
    const blocked = await call('get', '/api/v1/vendor/profile', vendor.accessToken).expect(403);
    expect(blocked.body.message).toBe('Turn on two-factor sign-in to continue');
    await call('patch', '/api/v1/auth/me', vendor.accessToken).send({ name: 'A' }).expect(403);

    const withMfa = await enableTwoFactor(app, vendor);
    // Enabling revokes the old session, including this access token.
    await call('get', '/api/v1/auth/me', vendor.accessToken).expect(401);
    await call('get', '/api/v1/vendor/profile', withMfa.accessToken).expect(200);
  });

  it('signs in with 2FA in two steps and refuses a replayed code', async () => {
    const vendor = await registerVendor(app);
    const step1 = await call('post', '/api/v1/auth/login')
      .send({ email: vendor.email, password: PASSWORD })
      .expect(200);
    expect(step1.body.data).toEqual({
      mfaRequired: true,
      mfaToken: expect.any(String),
      mfaTokenExpiresIn: 300,
    });
    // The mfaToken is not an access token.
    await call('get', '/api/v1/auth/me', step1.body.data.mfaToken).expect(401);

    await call('post', '/api/v1/auth/login/2fa')
      .send({ mfaToken: step1.body.data.mfaToken, code: '000000' })
      .expect(400);
    const code = freshTotp(vendor.totpSecret!);
    const ok = await call('post', '/api/v1/auth/login/2fa')
      .send({ mfaToken: step1.body.data.mfaToken, code })
      .expect(200);
    expect(ok.body.data).toMatchObject({ role: 'vendor', mfa: true });
    await call('post', '/api/v1/auth/login/2fa')
      .send({ mfaToken: step1.body.data.mfaToken, code })
      .expect(400);

    // A refreshed session stays 2FA-verified.
    const refreshed = await call('post', '/api/v1/auth/refresh')
      .send({ refreshToken: ok.body.data.refreshToken })
      .expect(200);
    expect(refreshed.body.data.mfa).toBe(true);
    await call('get', '/api/v1/vendor/profile', refreshed.body.data.accessToken).expect(200);
  });

  it('stores the 2FA secret encrypted, never in plain text', async () => {
    const vendor = await registerVendor(app);
    const { rows } = await pool.query<{ totp_secret: string }>(
      'SELECT totp_secret FROM users WHERE id = $1',
      [vendor.userId],
    );
    expect(rows[0].totp_secret).toMatch(/^v1\./);
    expect(rows[0].totp_secret).not.toContain(vendor.totpSecret);
  });

  it('lets customers opt into 2FA and out again; vendors cannot opt out', async () => {
    const customer = await enableTwoFactor(app, await registerCustomer(app));
    await call('post', '/api/v1/auth/2fa/disable', customer.accessToken)
      .send({ password: 'wrong-password', code: '000000' })
      .expect(400);
    await call('post', '/api/v1/auth/2fa/disable', customer.accessToken)
      .send({ password: PASSWORD, code: freshTotp(customer.totpSecret!) })
      .expect(200);
    const login = await call('post', '/api/v1/auth/login')
      .send({ email: customer.email, password: PASSWORD })
      .expect(200);
    expect(login.body.data.mfaRequired).toBe(false);

    const vendor = await registerVendor(app);
    const res = await call('post', '/api/v1/auth/2fa/disable', vendor.accessToken)
      .send({ password: PASSWORD, code: '123456' })
      .expect(403);
    expect(res.body.message).toBe('Two-factor sign-in is required for your account type');
  });

  it('rotates refresh tokens and revokes the session on reuse', async () => {
    const s = await registerCustomer(app);
    const r1 = await call('post', '/api/v1/auth/refresh')
      .send({ refreshToken: s.refreshToken })
      .expect(200);
    await call('post', '/api/v1/auth/refresh').send({ refreshToken: s.refreshToken }).expect(401);
    await call('post', '/api/v1/auth/refresh')
      .send({ refreshToken: r1.body.data.refreshToken })
      .expect(401);
    await call('get', '/api/v1/auth/me', r1.body.data.accessToken).expect(401);
  });

  it('resets a forgotten password and signs out every session', async () => {
    const s = await registerCustomer(app);
    await call('post', '/api/v1/auth/forgot-password').send({ email: s.email }).expect(200);
    await call('post', '/api/v1/auth/reset-password')
      .send({ email: s.email, otp: mailbox.get(s.email), newPassword: 'a-brand-new-secret' })
      .expect(200);
    await call('get', '/api/v1/auth/me', s.accessToken).expect(401);
    await call('post', '/api/v1/auth/login')
      .send({ email: s.email, password: 'a-brand-new-secret' })
      .expect(200);
  });

  it('updates name and phone, and stores an avatar', async () => {
    const s = await registerCustomer(app);
    const res = await call('patch', '/api/v1/auth/me', s.accessToken)
      .send({ name: 'Tunde Adebayo', phone: '+2348099990000' })
      .expect(200);
    expect(res.body.data).toMatchObject({ name: 'Tunde Adebayo', phone: '+2348099990000' });
    await call('patch', '/api/v1/auth/me', s.accessToken).send({ phone: '0803' }).expect(400);
    const cleared = await call('patch', '/api/v1/auth/me', s.accessToken)
      .send({ phone: null })
      .expect(200);
    expect(cleared.body.data.phone).toBeNull();
    const avatar = await call('put', '/api/v1/auth/me/avatar', s.accessToken)
      .attach('avatar', PNG_BYTES, 'me.png')
      .expect(200);
    expect(avatar.body.data.avatarUrl).toMatch(/^https:\/\/bucket\.test\/users\//);
  });

  it('keeps the audit log append-only', async () => {
    await expect(pool.query('UPDATE audit_log SET action = action')).rejects.toThrow(
      /append-only/,
    );
  });
});
