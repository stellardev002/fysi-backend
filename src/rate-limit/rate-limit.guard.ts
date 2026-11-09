import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import type { EnvVars } from '../config/env.validation.js';
import type { AuthenticatedRequest } from '../auth/auth-user.js';
import { RATE_LIMIT_KEY } from './rate-limit.decorator.js';
import {
  TokenBucketStore,
  type BucketConfig,
  type TakeResult,
} from './token-bucket.store.js';

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);
  private readonly globalBucket: BucketConfig;

  constructor(
    private readonly store: TokenBucketStore,
    private readonly reflector: Reflector,
    config: ConfigService<EnvVars, true>,
  ) {
    this.globalBucket = {
      capacity: config.get('RATE_LIMIT_CAPACITY', { infer: true }),
      refillPerSec: config.get('RATE_LIMIT_REFILL_PER_SEC', { infer: true }),
    };
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request & Partial<AuthenticatedRequest>>();
    const res = http.getResponse<Response>();
    const subject = req.user ? `user:${req.user.id}` : `ip:${req.ip}`;

    const routeBucket = this.reflector.getAllAndOverride<
      BucketConfig | undefined
    >(RATE_LIMIT_KEY, [context.getHandler(), context.getClass()]);

    const checks: Array<[string, BucketConfig]> = [
      [`rl:global:${subject}`, this.globalBucket],
    ];
    if (routeBucket) {
      const route = `${context.getClass().name}.${context.getHandler().name}`;
      checks.push([`rl:${route}:${subject}`, routeBucket]);
    }

    let tightest: { result: TakeResult; bucket: BucketConfig } | undefined;
    for (const [key, bucket] of checks) {
      let result: TakeResult;
      try {
        result = await this.store.take(key, bucket);
      } catch (err) {
        // Fail open: a Redis outage must not take the API down with it.
        this.logger.error(
          { err },
          'Rate limiter unavailable, allowing request',
        );
        return true;
      }
      if (!result.allowed) {
        res.setHeader('Retry-After', Math.ceil(result.retryAfterMs / 1000));
        res.setHeader('RateLimit-Limit', bucket.capacity);
        res.setHeader('RateLimit-Remaining', 0);
        throw new HttpException(
          'Too many requests',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (!tightest || result.remaining < tightest.result.remaining) {
        tightest = { result, bucket };
      }
    }

    if (tightest) {
      res.setHeader('RateLimit-Limit', tightest.bucket.capacity);
      res.setHeader('RateLimit-Remaining', tightest.result.remaining);
    }
    return true;
  }
}
