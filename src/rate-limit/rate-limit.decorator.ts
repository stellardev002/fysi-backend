import { SetMetadata } from '@nestjs/common';
import type { BucketConfig } from './token-bucket.store.js';

export const RATE_LIMIT_KEY = 'rateLimit';

/** Adds a stricter, route-scoped bucket on top of the global one. */
export const RateLimit = (bucket: BucketConfig) =>
  SetMetadata(RATE_LIMIT_KEY, bucket);
