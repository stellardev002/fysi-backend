import { createHmac } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Pool } from 'pg';
import {
  api,
  approvedVendor,
  createPool,
  createProduct,
  createTestApp,
  registerAdmin,
  registerCustomer,
  registerVendor,
  type Session,
} from './helpers.js';

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe('Security (e2e)', () => {
  let app: NestExpressApplication;
  let pool: Pool;
  let call: ReturnType<typeof api>;
  let admin: Session;

  beforeAll(async () => {
    app = await createTestApp();
    pool = createPool();
    call = api(app);
    admin = await registerAdmin(app, pool);
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  it('rejects unsigned, re-signed and role-tampered tokens', async () => {
    const customer = await registerCustomer(app);
    const [header, payload, signature] = customer.accessToken.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const forged = `${header}.${b64({ ...claims, role: 'super_admin', mfa: true })}.${signature}`;
    await call('get', '/api/v1/admin/users', forged).expect(401);
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ ...claims, role: 'admin' })}.`;
    await call('get', '/api/v1/admin/users', none).expect(401);
    const body = `${header}.${b64({ ...claims, role: 'admin' })}`;
    const wrongKey = createHmac('sha256', 'not-the-secret').update(body).digest('base64url');
    await call('get', '/api/v1/admin/users', `${body}.${wrongKey}`).expect(401);
  });

  it('ignores identity, role and status sent in bodies (mass assignment)', async () => {
    await call('post', '/api/v1/auth/register')
      .send({ name: 'X', email: 'x@example.test', password: 'long-enough-pw', role: 'admin' })
      .expect(400);
    const vendor = await registerVendor(app);
    await call('patch', '/api/v1/vendor/profile', vendor.accessToken)
      .send({ status: 'approved', verifiedCertifications: ['gots'] })
      .expect(400);
    const store = await approvedVendor(app, admin);
    await call('post', '/api/v1/vendor/products', store.accessToken)
      .send({
        title: 'Sneaky',
        description: 'A product that tries to set its own moderation state.',
        priceCents: 1000,
        stock: 1,
        categoryId: '00000000-0000-7000-8000-000000000000',
        moderationStatus: 'visible',
        vendorId: admin.userId,
      })
      .expect(400);
  });

  it('keeps vendor documents private', async () => {
    const vendor = await registerVendor(app);
    const other = await registerVendor(app);
    const customer = await registerCustomer(app);
    await call('get', `/api/v1/admin/vendors/${vendor.userId}`, other.accessToken).expect(403);
    await call('get', `/api/v1/admin/vendors/${vendor.userId}`, customer.accessToken).expect(403);
    await call('get', '/api/v1/vendor/profile', customer.accessToken).expect(403);
  });

  it('never shows unverified stores or their products publicly', async () => {
    const pending = await registerVendor(app);
    const { rows } = await pool.query<{ slug: string | null }>(
      'SELECT slug FROM vendors WHERE user_id = $1',
      [pending.userId],
    );
    expect(rows[0].slug).toBeNull();
    const store = await approvedVendor(app, admin);
    const p = await createProduct(app, store);
    await call('post', `/api/v1/admin/vendors/${store.userId}/suspend`, admin.accessToken)
      .send({ reason: 'Review' })
      .expect(200);
    await call('get', `/api/v1/products/${p.slug}`).expect(404);
    await call('post', '/api/v1/vendor/products', store.accessToken)
      .send({
        title: 'More stuff',
        description: 'Trying to list while suspended, which must fail.',
        priceCents: 1000,
        stock: 1,
        categoryId: p.category && (p.category as { id: string }).id,
      })
      .expect(403);
  });

  it('treats injection attempts in queries as plain values', async () => {
    for (const q of ["' OR 1=1 --", 'bamboo); drop table users; --', '%_\\'])
      await call('get', `/api/v1/products?q=${encodeURIComponent(q)}`).expect(200);
    await call('get', '/api/v1/products?sort=1;drop table users').expect(400);
    await call('get', "/api/v1/admin/vendors/' OR 1=1", admin.accessToken).expect(400);
  });

  it('stores markup as inert text', async () => {
    const vendor = await registerVendor(app);
    const res = await call('patch', '/api/v1/vendor/profile', vendor.accessToken)
      .send({ description: '<script>alert(1)</script>' })
      .expect(200);
    expect(res.body.data.description).toBe('<script>alert(1)</script>');
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('sends hardening headers and hides the framework', async () => {
    const res = await call('get', '/api/v1/categories').expect(200);
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-request-id']).toBeDefined();
  });
});
