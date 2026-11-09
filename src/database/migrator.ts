import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

// Arbitrary constant. Serialises concurrent replicas booting at once.
const MIGRATION_LOCK_ID = 727_001;

export async function runMigrations(
  databaseUrl: string,
  migrationsFolder: string,
): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const client = await pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
      await migrate(drizzle(client), { migrationsFolder });
    } finally {
      await client
        .query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID])
        .catch(() => undefined);
      client.release();
    }
  } finally {
    await pool.end();
  }
}
