import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../config/env.validation.js';
import { ObjectStorage } from './object-storage.js';
import { S3ObjectStorage } from './s3.storage.js';
import { UnconfiguredStorage } from './unconfigured.storage.js';

@Global()
@Module({
  providers: [
    {
      provide: ObjectStorage,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvVars, true>): ObjectStorage => {
        const bucket = config.get('S3_BUCKET', { infer: true });
        if (!bucket) return new UnconfiguredStorage();
        if (
          !config.get('S3_ACCESS_KEY_ID', { infer: true }) ||
          !config.get('S3_SECRET_ACCESS_KEY', { infer: true })
        )
          throw new Error(
            'S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required with S3_BUCKET',
          );
        return new S3ObjectStorage({
          endpoint: config.get('S3_ENDPOINT', { infer: true }),
          region: config.get('S3_REGION', { infer: true }),
          bucket,
          accessKeyId: config.get('S3_ACCESS_KEY_ID', { infer: true }),
          secretAccessKey: config.get('S3_SECRET_ACCESS_KEY', { infer: true }),
          forcePathStyle: config.get('S3_FORCE_PATH_STYLE', { infer: true }),
          downloadTtlSeconds: config.get('S3_DOWNLOAD_TTL_SECONDS', {
            infer: true,
          }),
        });
      },
    },
  ],
  exports: [ObjectStorage],
})
export class StorageModule {}
