import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type {
  NodePgQueryResultHKT,
  NodePgTransaction,
} from 'drizzle-orm/node-postgres';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import type { EnvVars } from '../config/env.validation.js';
import * as schema from './schema/index.js';

export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema>;
/** Writes take a Tx, so they cannot be called outside a transaction. */
export type Tx = NodePgTransaction<Schema, ExtractTablesWithRelations<Schema>>;
/** Reads accept either a pool-backed Db or a Tx. */
export type Executor = PgDatabase<
  NodePgQueryResultHKT,
  Schema,
  ExtractTablesWithRelations<Schema>
>;

@Injectable()
export class Database implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(Database.name);
  private readonly pool: Pool;
  private readonly startupAttempts: number;
  readonly db: Db;

  constructor(config: ConfigService<EnvVars, true>) {
    this.startupAttempts = config.get('DB_STARTUP_ATTEMPTS', { infer: true });
    this.pool = new Pool({
      connectionString: config.get('DATABASE_URL', { infer: true }),
      max: config.get('DB_POOL_MAX', { infer: true }),
      statement_timeout: config.get('DB_STATEMENT_TIMEOUT_MS', {
        infer: true,
      }),
    });
    this.pool.on('error', (err) =>
      this.logger.error({ err }, 'Idle Postgres client error'),
    );
    this.db = drizzle(this.pool, { schema, casing: 'snake_case' });
  }

  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(fn);
  }

  /** One consistent view for a rows + count read. */
  readSnapshot<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(fn, {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
  }

  /**
   * Runs `work` while holding a cluster-wide lock, so instances take turns.
   * Waiting longer than the statement timeout fails instead of queueing forever.
   */
  async exclusive<T>(key: number, work: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [key]);
      try {
        return await work();
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [key]);
      }
    } finally {
      client.release();
    }
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  /**
   * Fails the boot after a few backed-off attempts, so a wrong DATABASE_URL shows
   * up as a clear crash in the host's logs instead of a server that 500s on every call.
   */
  async onModuleInit(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.ping();
        if (attempt > 1) this.logger.log('Connected to Postgres');
        return;
      } catch (err) {
        if (attempt >= this.startupAttempts) {
          this.logger.error(
            { err },
            `Postgres unreachable after ${attempt} attempts; check DATABASE_URL`,
          );
          throw err;
        }
        const waitMs = Math.min(500 * 2 ** (attempt - 1), 8000);
        this.logger.warn(
          `Postgres not reachable (attempt ${attempt}/${this.startupAttempts}), retrying in ${waitMs}ms`,
        );
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
