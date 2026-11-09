export abstract class ObjectStorage {
  abstract put(key: string, body: Buffer, contentType: string): Promise<void>;

  abstract presignDownload(key: string): Promise<string>;

  abstract delete(keys: string[]): Promise<void>;
}
