import type { OtpPurpose } from '../database/schema/index.js';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

export const OTP_LENGTH = 6;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_MS = 60_000;

export const generateOtp = (): string =>
  randomInt(0, 10 ** OTP_LENGTH)
    .toString()
    .padStart(OTP_LENGTH, '0');

/** Keyed so a leaked table cannot be brute-forced over the 10^6 code space. */
export const hashOtp = (
  secret: string,
  purpose: OtpPurpose,
  userId: string,
  code: string,
): string =>
  createHmac('sha256', secret)
    .update(`${purpose}:${userId}:${code}`)
    .digest('hex');

export const otpMatches = (expectedHash: string, actualHash: string): boolean =>
  expectedHash.length === actualHash.length &&
  timingSafeEqual(Buffer.from(expectedHash), Buffer.from(actualHash));
