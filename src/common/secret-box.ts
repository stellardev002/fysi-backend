import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';

/**
 * Encrypts small secrets for storage (TOTP secrets, director NIN/BVN) with
 * AES-256-GCM. `context` (e.g. `totp:<userId>`) is bound in as associated data,
 * so a ciphertext copied onto another row or column fails to open.
 */
export class SecretBox {
  readonly #key: Buffer;

  constructor(base64Key: string) {
    const key = Buffer.from(base64Key, 'base64');
    if (key.length !== 32)
      throw new Error('DATA_ENCRYPTION_KEY must decode to 32 bytes');
    this.#key = key;
  }

  seal(plaintext: string, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(Buffer.from(context));
    const body = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    return [VERSION, iv, cipher.getAuthTag(), body]
      .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
      .join('.');
  }

  /** Throws when the value was tampered with, sealed for another context or with another key. */
  open(sealed: string, context: string): string {
    const [version, iv, tag, body] = sealed.split('.');
    if (version !== VERSION || !iv || !tag || body === undefined)
      throw new Error('Not a sealed value');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.#key,
      Buffer.from(iv, 'base64url'),
    );
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(body, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}
