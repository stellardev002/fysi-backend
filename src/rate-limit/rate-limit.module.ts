import { Module } from '@nestjs/common';
import { RateLimitGuard } from './rate-limit.guard.js';
import { TokenBucketStore } from './token-bucket.store.js';

@Module({
  providers: [TokenBucketStore, RateLimitGuard],
  exports: [TokenBucketStore, RateLimitGuard],
})
export class RateLimitModule {}
