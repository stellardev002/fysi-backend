import { resolve } from 'node:path';
import { runMigrations } from './migrator.js';

// Migrations hold a session-level advisory lock, so they need a session-mode
// connection (never a transaction pooler such as PgBouncer or Supabase's port 6543).
const databaseUrl =
  process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required to run migrations');
  process.exit(1);
}

const folder = resolve(process.cwd(), process.env.MIGRATIONS_DIR ?? 'drizzle');

try {
  console.log(`Applying migrations from ${folder}`);
  await runMigrations(databaseUrl, folder);
  console.log('Migrations applied');
} catch (err) {
  console.error('Migration failed', err);
  process.exit(1);
}
