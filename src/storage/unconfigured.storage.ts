import { ServiceUnavailableException } from '@nestjs/common';
import type { ObjectStorage } from './object-storage.js';

/** Stands in when no bucket is configured, so only image routes fail. */
export class UnconfiguredStorage implements ObjectStorage {
  private fail(): never {
    throw new ServiceUnavailableException('Image storage is not configured');
  }
  put(): never {
    return this.fail();
  }
  presignDownload(): never {
    return this.fail();
  }
  delete(): never {
    return this.fail();
  }
}
