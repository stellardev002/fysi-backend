import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Pool } from 'pg';
import {
  api,
  approvedVendor,
  BUSINESS,
  categoryId,
  completeApplication,
  createPool,
  createTestApp,
  fakeBucket,
  PDF_BYTES,
  registerAdmin,
  registerVendor,
  sentSubjects,
  type Session,
} from './helpers.js';

describe('Vendor onboarding and verification (e2e)', () => {
  let app: NestExpressApplication;
  let pool: Pool;
  let call: ReturnType<typeof api>;
  let admin: Session;

  beforeAll(async () => {
    app = await createTestApp();
    pool = createPool();
    call = api(app);
    admin = await registerAdmin(app, pool, 'admin');
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  it('lists what is missing, then accepts a complete application', async () => {
    const vendor = await registerVendor(app);
    const empty = await call('get', '/api/v1/vendor/profile', vendor.accessToken).expect(200);
    expect(empty.body.data).toMatchObject({ status: 'draft', canEdit: true });
    expect(empty.body.data.missing).toEqual(
      expect.arrayContaining(['businessName', 'cacNumber', 'directorId', 'document:cac_certificate']),
    );
    const early = await call('post', '/api/v1/vendor/submit', vendor.accessToken).expect(400);
    expect(early.body.error.details).toContain('cacNumber');

    await completeApplication(app, vendor);
    const ready = await call('get', '/api/v1/vendor/profile', vendor.accessToken).expect(200);
    expect(ready.body.data.missing).toEqual([]);
    expect(ready.body.data.directorIdLast4).toBe('8901');
    expect(ready.body.data.documents).toHaveLength(2);
    expect(ready.body.data.documents[0].url).toMatch(/^https:\/\/bucket\.test\/vendors\//);

    const submitted = await call('post', '/api/v1/vendor/submit', vendor.accessToken).expect(200);
    expect(submitted.body.data).toMatchObject({ status: 'pending', canEdit: false });
    await call('post', '/api/v1/vendor/submit', vendor.accessToken).expect(409);
  });

  it('encrypts the director NIN/BVN and never returns it', async () => {
    const vendor = await registerVendor(app);
    await call('patch', '/api/v1/vendor/profile', vendor.accessToken)
      .send({ directorIdType: 'bvn', directorId: '22233344455' })
      .expect(200);
    const { rows } = await pool.query<{ director_id_encrypted: string }>(
      'SELECT director_id_encrypted FROM vendors WHERE user_id = $1',
      [vendor.userId],
    );
    expect(rows[0].director_id_encrypted).toMatch(/^v1\./);
    expect(rows[0].director_id_encrypted).not.toContain('22233344455');
    const profile = await call('get', '/api/v1/vendor/profile', vendor.accessToken);
    expect(JSON.stringify(profile.body)).not.toContain('22233344455');
    const audit = await pool.query(
      `SELECT metadata FROM audit_log WHERE resource_id = $1`,
      [vendor.userId],
    );
    expect(JSON.stringify(audit.rows)).not.toContain('22233344455');
  });

  it('validates the wizard input', async () => {
    const vendor = await registerVendor(app);
    const res = await call('patch', '/api/v1/vendor/profile', vendor.accessToken)
      .send({ cacNumber: '12345', state: 'Atlantis', directorId: '123' })
      .expect(400);
    expect(res.body.error.details.join(' ')).toMatch(/cacNumber[\s\S]*state|state[\s\S]*cacNumber/);
    await call('post', '/api/v1/vendor/documents', vendor.accessToken)
      .field('kind', 'cac_certificate')
      .attach('file', Buffer.from('MZ not a pdf'), 'cac.pdf')
      .expect(415);
    await call('post', '/api/v1/vendor/documents', vendor.accessToken)
      .field('kind', 'sustainability_certificate')
      .attach('file', PDF_BYTES, 'cert.pdf')
      .expect(400);
    await call('post', '/api/v1/vendor/documents', vendor.accessToken)
      .field('kind', 'cac_certificate')
      .field('certification', 'gots')
      .attach('file', PDF_BYTES, 'cac.pdf')
      .expect(400);
  });

  it('runs the review queue: reject with reason, fix, resubmit, approve', async () => {
    const vendor = await registerVendor(app);
    await completeApplication(app, vendor, { businessName: 'Leaf & Loom' });
    await call('post', '/api/v1/vendor/submit', vendor.accessToken).expect(200);

    const queue = await call('get', '/api/v1/admin/vendors?status=pending&limit=100', admin.accessToken).expect(200);
    const entry = queue.body.data.result.find((v: { id: string }) => v.id === vendor.userId);
    expect(entry).toMatchObject({ status: 'pending', businessName: 'Leaf & Loom' });
    expect(entry.waitingHours).toBeGreaterThanOrEqual(0);

    const detail = await call('get', `/api/v1/admin/vendors/${vendor.userId}`, admin.accessToken).expect(200);
    expect(detail.body.data).toMatchObject({
      claimedCertifications: [{ id: 'gots', name: 'GOTS' }],
      owner: { twoFactorEnabled: true, suspended: false },
    });

    await call('post', `/api/v1/admin/vendors/${vendor.userId}/reject`, admin.accessToken)
      .send({ reason: 'The CAC certificate is unreadable.' })
      .expect(200);
    const rejected = await call('get', '/api/v1/vendor/profile', vendor.accessToken).expect(200);
    expect(rejected.body.data).toMatchObject({
      status: 'rejected',
      canEdit: true,
      decisionReason: 'The CAC certificate is unreadable.',
    });
    expect(sentSubjects.get(vendor.email)?.at(-1)).toMatch(/not approved/);

    // Fix and resubmit.
    const doc = rejected.body.data.documents.find((d: { kind: string }) => d.kind === 'cac_certificate');
    await call('delete', `/api/v1/vendor/documents/${doc.id}`, vendor.accessToken).expect(200);
    await call('post', '/api/v1/vendor/documents', vendor.accessToken)
      .field('kind', 'cac_certificate')
      .attach('file', PDF_BYTES, 'cac-clear.pdf')
      .expect(201);
    await call('post', '/api/v1/vendor/submit', vendor.accessToken).expect(200);

    await call('post', `/api/v1/admin/vendors/${vendor.userId}/approve`, admin.accessToken)
      .send({ certifications: ['fsc'] })
      .expect(400);
    const approved = await call('post', `/api/v1/admin/vendors/${vendor.userId}/approve`, admin.accessToken)
      .send({ foundingVendor: true, note: 'Welcome!' })
      .expect(200);
    expect(approved.body.data).toMatchObject({
      status: 'approved',
      // The plain slug unless an earlier run on this database took it.
      slug: expect.stringMatching(/^leaf-loom(-[a-z0-9]{6})?$/),
      badge: 'certified',
      foundingVendor: true,
      verifiedCertifications: [{ id: 'gots', name: 'GOTS' }],
      submissionCount: 2,
    });
    expect(approved.body.data.history.map((h: { action: string }) => h.action)).toEqual(
      expect.arrayContaining(['vendor.approved', 'vendor.rejected', 'vendor.submitted']),
    );
    expect(sentSubjects.get(vendor.email)?.at(-1)).toMatch(/verified/);

    // Identity locks after approval; description stays editable.
    await call('patch', '/api/v1/vendor/profile', vendor.accessToken)
      .send({ businessName: 'Another name' })
      .expect(409);
    await call('patch', '/api/v1/vendor/profile', vendor.accessToken)
      .send({ description: 'Handwoven from recycled fabric.' })
      .expect(200);
  });

  it('gives the store a public page, hidden while suspended', async () => {
    const vendor = await approvedVendor(app, admin, { certification: null });
    const store = await call('get', `/api/v1/vendors/${vendor.slug}`).expect(200);
    expect(store.body.data).toMatchObject({
      slug: vendor.slug,
      badge: 'fysi_reviewed',
      certifications: [],
      productCount: 0,
    });
    await call('post', `/api/v1/admin/vendors/${vendor.userId}/suspend`, admin.accessToken)
      .send({ reason: 'Selling non-eco items.' })
      .expect(200);
    await call('get', `/api/v1/vendors/${vendor.slug}`).expect(404);
    await call('post', `/api/v1/admin/vendors/${vendor.userId}/reinstate`, admin.accessToken)
      .send({})
      .expect(200);
    await call('get', `/api/v1/vendors/${vendor.slug}`).expect(200);
  });

  it('refuses decisions from the wrong status and from non-admins', async () => {
    const vendor = await registerVendor(app);
    await call('post', `/api/v1/admin/vendors/${vendor.userId}/approve`, admin.accessToken)
      .send({})
      .expect(409);
    await call('get', '/api/v1/admin/vendors', vendor.accessToken).expect(403);
    await call('get', '/api/v1/admin/vendors/00000000-0000-7000-8000-000000000000', admin.accessToken).expect(404);
  });

  it('keeps logos replaceable and deletes the old file', async () => {
    const vendor = await registerVendor(app);
    const first = await call('put', '/api/v1/vendor/profile/logo', vendor.accessToken)
      .attach('logo', Buffer.from([0xff, 0xd8, 0xff, 0]), 'logo.jpg')
      .expect(200);
    const firstKey = new URL(first.body.data.logoUrl).pathname.slice(1);
    expect(fakeBucket.has(firstKey)).toBe(true);
    await call('put', '/api/v1/vendor/profile/logo', vendor.accessToken)
      .attach('logo', Buffer.from([0xff, 0xd8, 0xff, 0]), 'logo2.jpg')
      .expect(200);
    expect(fakeBucket.has(firstKey)).toBe(false);
  });

  it('rejects a business category that is not active', async () => {
    const vendor = await registerVendor(app);
    const cat = await categoryId(app);
    await pool.query('UPDATE categories SET is_active = false WHERE id = $1', [cat]);
    try {
      await call('patch', '/api/v1/vendor/profile', vendor.accessToken)
        .send({ ...BUSINESS, categoryId: cat })
        .expect(400);
    } finally {
      await pool.query('UPDATE categories SET is_active = true WHERE id = $1', [cat]);
    }
  });
});
