import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Pool } from 'pg';
import request from 'supertest';
import { createPool, createTestApp, freshIp } from './helpers.js';

describe('Database (e2e)', () => {
  let app: NestExpressApplication;
  let pool: Pool;

  beforeAll(async () => {
    app = await createTestApp();
    pool = createPool();
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  it('reports Postgres up on /health', async () => {
    const res = await request(app.getHttpServer())
      .get('/health')
      .set('X-Forwarded-For', freshIp());
    // A down Redis turns the whole check into a 503 with per-dependency details.
    const database =
      res.body.data?.info?.database ??
      res.body.error?.details?.details?.database;
    expect(database).toEqual({ status: 'up' });
  });

  // Supabase exposes the public schema to browsers; a table without RLS leaks.
  it('has row-level security on every public table', async () => {
    const { rows } = await pool.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity`,
    );
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it('gives the Supabase browser roles no access to any table', async () => {
    const { rows } = await pool.query<{ grantee: string; table_name: string }>(
      `SELECT grantee, table_name FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')`,
    );
    expect(rows).toEqual([]);
  });
});
