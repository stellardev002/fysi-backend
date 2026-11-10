import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import type { ObjectStorage } from './object-storage.js';

export interface S3Settings {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  downloadTtlSeconds: number;
}

/** Any S3-compatible store: a Railway bucket, Cloudflare R2, AWS S3, Supabase Storage. */
export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly logger = new Logger(S3ObjectStorage.name);

  constructor(private readonly s: S3Settings) {
    this.client = new S3Client({
      endpoint: s.endpoint || undefined,
      region: s.region,
      forcePathStyle: s.forcePathStyle,
      // Skip optional checksum headers that some S3-compatible stores reject.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      credentials: {
        accessKeyId: s.accessKeyId,
        secretAccessKey: s.secretAccessKey,
      },
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.s.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          ContentLength: body.length,
          CacheControl: 'private, max-age=31536000, immutable',
        }),
      );
    } catch (err) {
      // Bad credentials or a store outage: the client can only retry later.
      this.logger.error({ err, key }, 'Image upload to storage failed');
      throw new ServiceUnavailableException('Image storage is unavailable');
    }
  }

  presignDownload(key: string): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.s.bucket, Key: key }),
      { expiresIn: this.s.downloadTtlSeconds },
    );
  }

  async delete(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.client.send(
      new DeleteObjectsCommand({
        Bucket: this.s.bucket,
        Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
      }),
    );
  }
}
