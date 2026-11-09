import {
  Controller,
  Get,
  HttpStatus,
  Inject,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorService,
  type HealthIndicatorResult,
} from '@nestjs/terminus';
import { ApiTags } from '@nestjs/swagger';
import { Redis } from 'ioredis';
import { Public } from '../auth/decorators.js';
import { ApiRoute } from '../common/api-docs.js';
import { Database } from '../database/database.js';
import { REDIS } from '../redis/redis.module.js';

// Public so the host's health check (Railway, uptime monitors) can call it.
// It reveals only up/down per dependency.
@ApiTags('Health')
@Public()
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicators: HealthIndicatorService,
    private readonly database: Database,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @ApiRoute({
    summary: 'Health check',
    path: '/health',
    description:
      'Pings Postgres and Redis. No token needed. A failing dependency returns 503. Not versioned: the path is `/health`, not `/api/v1/health`.',
    message: 'Health check passed',
    example: {
      status: 'ok',
      info: { database: { status: 'up' }, redis: { status: 'up' } },
    },
    errors: [
      {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        message: 'Service Unavailable',
        description: 'A dependency is down.',
      },
    ],
  })
  @HealthCheck()
  @Get()
  check() {
    return this.health.check([
      () => this.probe('database', () => this.database.ping()),
      () => this.probe('redis', () => this.redis.ping()),
    ]);
  }

  private async probe(
    key: string,
    fn: () => Promise<unknown>,
  ): Promise<HealthIndicatorResult> {
    const session = this.indicators.check(key);
    try {
      await fn();
      return session.up();
    } catch {
      return session.down();
    }
  }
}
