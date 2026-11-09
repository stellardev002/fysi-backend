import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS } from '../redis/redis.module.js';

export interface BucketConfig {
  /** Maximum burst size, also the starting balance. */
  capacity: number;
  /** Tokens added per second. */
  refillPerSec: number;
}

export interface TakeResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

// Runs atomically in Redis. Uses Redis TIME so replicas share one clock.
const TAKE_SCRIPT = `
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local data = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then
  tokens = capacity
  ts = now
end
tokens = math.min(capacity, tokens + math.max(0, now - ts) * refill / 1000)
local allowed = 0
local retry = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry = math.ceil((cost - tokens) * 1000 / refill)
end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / refill * 1000) + 1000)
return { allowed, math.floor(tokens), retry }
`;

type TakeCommand = (
  key: string,
  capacity: number,
  refillPerSec: number,
  cost: number,
) => Promise<[number, number, number]>;

@Injectable()
export class TokenBucketStore {
  private readonly takeToken: TakeCommand;

  constructor(@Inject(REDIS) redis: Redis) {
    redis.defineCommand('takeToken', { numberOfKeys: 1, lua: TAKE_SCRIPT });
    this.takeToken = (
      redis as unknown as { takeToken: TakeCommand }
    ).takeToken.bind(redis);
  }

  async take(key: string, bucket: BucketConfig, cost = 1): Promise<TakeResult> {
    const [allowed, remaining, retryAfterMs] = await this.takeToken(
      key,
      bucket.capacity,
      bucket.refillPerSec,
      cost,
    );
    return { allowed: allowed === 1, remaining, retryAfterMs };
  }
}
