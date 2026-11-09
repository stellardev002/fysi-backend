import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  otpauthUrl,
  totpCode,
  totpStep,
  verifyTotp,
} from './totp.js';

// RFC 6238 appendix B secret ("12345678901234567890") for SHA-1.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('totp', () => {
  it('matches the RFC 6238 test vectors (last 6 digits)', () => {
    expect(totpCode(RFC_SECRET, totpStep(59_000))).toBe('287082');
    expect(totpCode(RFC_SECRET, totpStep(1_111_111_109_000))).toBe('081804');
    expect(totpCode(RFC_SECRET, totpStep(2_000_000_000_000))).toBe('279037');
  });

  it('round-trips base32', () => {
    const bytes = Buffer.from('any bytes at all \u0000ÿ');
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    expect(generateTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
  });

  it('accepts the current code and one step of drift, nothing further', () => {
    const now = 1_700_000_000_000;
    const step = totpStep(now);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step), null, now)).toBe(
      step,
    );
    expect(
      verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), null, now),
    ).toBe(step - 1);
    expect(
      verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 2), null, now),
    ).toBeNull();
    expect(verifyTotp(RFC_SECRET, 'abcdef', null, now)).toBeNull();
  });

  it('refuses a code from a step already used', () => {
    const now = 1_700_000_000_000;
    const step = totpStep(now);
    const code = totpCode(RFC_SECRET, step);
    expect(verifyTotp(RFC_SECRET, code, step, now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, code, step - 1, now)).toBe(step);
  });

  it('builds an otpauth URL authenticator apps can scan', () => {
    const url = otpauthUrl('Fysi', 'aisha@example.com', 'ABCDEF');
    expect(url).toBe(
      'otpauth://totp/Fysi%3Aaisha%40example.com?secret=ABCDEF&issuer=Fysi&algorithm=SHA1&digits=6&period=30',
    );
  });
});
