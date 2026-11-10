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
  registerAdmin,
  registerCustomer,
  registerVendor,
  type Session,
  uniqueEmail,
} from './helpers.js';

describe('Admin console and roles (e2e)', () => {
  let app: NestExpressApplication;
  let pool: Pool;
  let call: ReturnType<typeof api>;
  let superAdmin: Session;
  let admin: Session;

  beforeAll(async () => {
    app = await createTestApp();
    pool = createPool();
    call = api(app);
    superAdmin = await registerAdmin(app, pool, 'super_admin');
    admin = await registerAdmin(app, pool, 'admin');
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  const adminRoutes = [
    ['get', '/api/v1/admin/users'],
    ['get', '/api/v1/admin/vendors'],
    ['get', '/api/v1/admin/products'],
    ['get', '/api/v1/admin/categories'],
    ['get', '/api/v1/audit-logs'],
  ] as const;

  it.each(adminRoutes)('%s %s: 401 anonymous, 403 customers and vendors', async (method, path) => {
    await call(method, path).expect(401);
    const customer = await registerCustomer(app);
    await call(method, path, customer.accessToken).expect(403);
    const vendor = await registerVendor(app);
    await call(method, path, vendor.accessToken).expect(403);
    await call(method, path, admin.accessToken).expect(200);
  });

  it('lets an admin use the console with a password; 2FA stays optional', async () => {
    const fresh = await registerCustomer(app);
    await pool.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [fresh.userId]);
    const login = await call('post', '/api/v1/auth/login')
      .send({ email: fresh.email, password: PASSWORD })
      .expect(200);
    expect(login.body.data.twoFactorSetupRequired).toBe(false);
    await call('get', '/api/v1/admin/users', login.body.data.accessToken).expect(200);
    const withMfa = await enableTwoFactor(app, {
      ...fresh,
      accessToken: login.body.data.accessToken,
    });
    await call('get', '/api/v1/admin/users', withMfa.accessToken).expect(200);
  });

  it('lets only super admins create admins, who pick their own password', async () => {
    const email = uniqueEmail();
    await call('post', '/api/v1/admin/users', admin.accessToken)
      .send({ email, name: 'Chiamaka' })
      .expect(403);
    const created = await call('post', '/api/v1/admin/users', superAdmin.accessToken)
      .send({ email, name: 'Chiamaka' })
      .expect(201);
    expect(created.body.data.role).toBe('admin');
    await call('post', '/api/v1/auth/reset-password')
      .send({ email, otp: mailbox.get(email), newPassword: 'her-own-strong-password' })
      .expect(200);
    const login = await call('post', '/api/v1/auth/login')
      .send({ email, password: 'her-own-strong-password' })
      .expect(200);
    expect(login.body.data).toMatchObject({ role: 'admin', twoFactorSetupRequired: false });
    // Role-based access: the new admin reaches the console with a password alone.
    await call('get', '/api/v1/admin/users', login.body.data.accessToken).expect(200);
  });

  it('suspends and restores accounts, with the staff hierarchy', async () => {
    const customer = await registerCustomer(app);
    const suspended = await call('post', `/api/v1/admin/users/${customer.userId}/suspension`, admin.accessToken)
      .send({ reason: 'Chargeback fraud' })
      .expect(201);
    expect(suspended.body.data).toMatchObject({ suspended: true, suspension: { reason: 'Chargeback fraud' } });
    await call('get', '/api/v1/auth/me', customer.accessToken).expect(401);
    await call('post', '/api/v1/auth/login')
      .send({ email: customer.email, password: PASSWORD })
      .expect(403);
    await call('delete', `/api/v1/admin/users/${customer.userId}/suspension`, admin.accessToken).expect(200);
    await call('post', '/api/v1/auth/login')
      .send({ email: customer.email, password: PASSWORD })
      .expect(200);

    // Admins cannot act on staff; super admins can; nobody on themselves.
    await call('post', `/api/v1/admin/users/${superAdmin.userId}/suspension`, admin.accessToken)
      .send({ reason: 'Trying' })
      .expect(403);
    await call('post', `/api/v1/admin/users/${admin.userId}/suspension`, admin.accessToken)
      .send({ reason: 'Self' })
      .expect(400);
  });

  it('resets 2FA for a vendor who lost their phone', async () => {
    const vendor = await registerVendor(app);
    const reset = await call('post', `/api/v1/admin/users/${vendor.userId}/2fa/reset`, admin.accessToken)
      .send({ reason: 'Lost phone; identity confirmed on a call' })
      .expect(200);
    expect(reset.body.data.twoFactorEnabled).toBe(false);
    await call('get', '/api/v1/auth/me', vendor.accessToken).expect(401);
    const login = await call('post', '/api/v1/auth/login')
      .send({ email: vendor.email, password: PASSWORD })
      .expect(200);
    expect(login.body.data).toMatchObject({ mfaRequired: false, twoFactorSetupRequired: false });
  });

  it('records admin actions in the audit log', async () => {
    const name = `Kitchen ${Date.now()}`;
    await call('post', '/api/v1/admin/categories', admin.accessToken).send({ name }).expect(201);
    const log = await call('get', `/api/v1/audit-logs?actorId=${admin.userId}&limit=100`, admin.accessToken).expect(200);
    expect(log.body.data.result.map((e: { action: string }) => e.action)).toContain('category.created');
  });

  it('signs a super admin in with 2FA', async () => {
    const step1 = await call('post', '/api/v1/auth/login')
      .send({ email: superAdmin.email, password: PASSWORD })
      .expect(200);
    const res = await call('post', '/api/v1/auth/login/2fa')
      .send({ mfaToken: step1.body.data.mfaToken, code: freshTotp(superAdmin.totpSecret!) })
      .expect(200);
    expect(res.body.data).toMatchObject({ role: 'super_admin', mfa: true });
  });
});
