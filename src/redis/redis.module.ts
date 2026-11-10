import {
  Global,
  Inject,
  Logger,
  Module,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { EnvVars } from '../config/env.validation.js';

export const REDIS = Symbol('REDIS');

class RedisLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Redis');

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Warns only: rate limiting fails open, so the API still serves without Redis. */
  async onApplicationBootstrap(): Promise<void> {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await this.redis.ping();
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
    this.logger.warn(
      'Redis unreachable at startup; rate limiting is off until it connects. Check REDIS_URL',
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvVars, true>) => {
        const logger = new Logger('Redis');
        const redis = new Redis(config.get('REDIS_URL', { infer: true }), {
          // Fail fast while disconnected so callers can degrade instead of hanging.
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          commandTimeout: 1000,
          // Resolve IPv4 or IPv6: Railway's private network (*.railway.internal)
          // can be IPv6-only, and ioredis looks up IPv4 alone by default.
          family: 0,
        });
        redis.on('error', (err) => logger.error({ err }, 'Redis error'));
        return redis;
      },
    },
    RedisLifecycle,
  ],
  exports: [REDIS],
})
export class RedisModule {}
