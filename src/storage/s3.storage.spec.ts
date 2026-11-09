import { describe, expect, it } from 'vitest';
import { S3ObjectStorage } from './s3.storage.js';

describe('S3ObjectStorage', () => {
  const storage = new S3ObjectStorage({
    endpoint: 'https://storage.example.test',
    region: 'auto',
    bucket: 'b',
    accessKeyId: 'AKIATEST',
    secretAccessKey: 'secret',
    forcePathStyle: true,
    downloadTtlSeconds: 3600,
  });

  it('presigns reads with the configured lifetime', async () => {
    const url = new URL(await storage.presignDownload('k/a.jpg'));
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(url.pathname).toBe('/b/k/a.jpg');
  });
});
