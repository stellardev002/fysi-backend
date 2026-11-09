import { describe, expect, it } from 'vitest';
import { generateOtp, hashOtp, otpMatches } from './otp.js';

describe('otp', () => {
  it('generates six digits, keeping leading zeros', () => {
    for (let i = 0; i < 200; i++) expect(generateOtp()).toMatch(/^\d{6}$/);
  });

  it('matches only the same secret, purpose, user and code', () => {
    const h = hashOtp('s', 'verify_email', 'u1', '123456');
    const same = hashOtp('s', 'verify_email', 'u1', '123456');
    expect(otpMatches(h, same)).toBe(true);
    expect(otpMatches(h, hashOtp('s', 'verify_email', 'u1', '123457'))).toBe(
      false,
    );
    expect(otpMatches(h, hashOtp('s', 'verify_email', 'u2', '123456'))).toBe(
      false,
    );
    expect(otpMatches(h, hashOtp('t', 'verify_email', 'u1', '123456'))).toBe(
      false,
    );
    expect(otpMatches(h, hashOtp('s', 'reset_password', 'u1', '123456'))).toBe(
      false,
    );
  });
});
