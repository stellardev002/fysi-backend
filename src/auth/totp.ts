import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** RFC 6238 defaults, which every authenticator app supports. */
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Codes one step either side are accepted, for clock drift. */
const WINDOW = 1;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('Invalid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160-bit secret, base32 as authenticator apps expect. */
export const generateTotpSecret = (): string => base32Encode(randomBytes(20));

export const totpStep = (now = Date.now()): number =>
  Math.floor(now / 1000 / TOTP_PERIOD_SECONDS);

export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return (binary % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, '0');
}

/**
 * The step the code belongs to, or null. Steps at or before `lastStep` are
 * refused, so a code (or an older one) cannot be replayed.
 */
export function verifyTotp(
  secret: string,
  code: string,
  lastStep: number | null,
  now = Date.now(),
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = totpStep(now);
  for (let step = current - WINDOW; step <= current + WINDOW; step++) {
    if (lastStep !== null && step <= lastStep) continue;
    const expected = Buffer.from(totpCode(secret, step));
    if (timingSafeEqual(expected, Buffer.from(code))) return step;
  }
  return null;
}

export const otpauthUrl = (
  issuer: string,
  account: string,
  secret: string,
): string => {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
};
