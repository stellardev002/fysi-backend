import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretBox } from './secret-box.js';

const key = () => randomBytes(32).toString('base64');

describe('SecretBox', () => {
  it('round-trips and never repeats a ciphertext', () => {
    const box = new SecretBox(key());
    const a = box.seal('12345678901', 'director:u1');
    const b = box.seal('12345678901', 'director:u1');
    expect(a).not.toBe(b);
    expect(a).not.toContain('12345678901');
    expect(box.open(a, 'director:u1')).toBe('12345678901');
  });

  it('refuses another context, another key, or a tampered value', () => {
    const box = new SecretBox(key());
    const sealed = box.seal('secret', 'totp:u1');
    expect(() => box.open(sealed, 'totp:u2')).toThrow();
    expect(() => new SecretBox(key()).open(sealed, 'totp:u1')).toThrow();
    const parts = sealed.split('.');
    parts[3] = Buffer.from('other').toString('base64url');
    expect(() => box.open(parts.join('.'), 'totp:u1')).toThrow();
    expect(() => box.open('garbage', 'totp:u1')).toThrow();
  });

  it('rejects a key that is not 32 bytes', () => {
    expect(() => new SecretBox(randomBytes(16).toString('base64'))).toThrow(
      /32 bytes/,
    );
  });
});
