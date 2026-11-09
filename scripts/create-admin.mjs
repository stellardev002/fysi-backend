// Creates a super admin straight in the database. Use it for the first one;
// super admins then add admins through POST /api/v1/admin/users (PRD A7).
// The new account must turn on two-factor sign-in at its first login.
//
//   pnpm admin:create --email ugo@fysi.ng --name "Ugochinyere Eze"
//
// The password comes from ADMIN_PASSWORD (at least 12 characters). Without it a random one is
// generated and printed once. Put it in no file and change it after the first login.
import { randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import pg from 'pg';
import { v7 } from 'uuid';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, token, i, all) => {
    if (token.startsWith('--')) pairs.push([token.slice(2), all[i + 1]]);
    return pairs;
  }, []),
);

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const email = args.email?.trim().toLowerCase();
const name = args.name?.trim();
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
  fail('--email is required and must be an email');
if (!name) fail('--name is required, e.g. --name "Ugochinyere Eze"');
if (!process.env.DATABASE_URL) fail('DATABASE_URL is not set');

const given = process.env.ADMIN_PASSWORD;
if (given !== undefined && given.length < 12)
  fail('ADMIN_PASSWORD must be at least 12 characters');
const password = given ?? randomBytes(18).toString('base64url');

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const existing = await pool.query('SELECT role FROM users WHERE email = $1', [
    email,
  ]);
  if (existing.rowCount > 0)
    fail(
      `An account with this email already exists (role: ${existing.rows[0].role}). Nothing was changed.`,
    );

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = v7();
    await client.query(
      `INSERT INTO users (id, email, password_hash, role, name, email_verified_at)
       VALUES ($1, $2, $3, 'super_admin', $4, now())`,
      [id, email, await hash(password), name],
    );
    await client.query(
      `INSERT INTO audit_log (action, resource_type, resource_id, metadata)
       VALUES ('admin.created', 'user', $1, '{"source":"cli"}'::jsonb)`,
      [id],
    );
    await client.query('COMMIT');
    console.log(`Super admin ${email} created (id ${id}). Turn on 2FA at first sign-in.`);
    if (given === undefined)
      console.log(`Temporary password (shown once): ${password}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
