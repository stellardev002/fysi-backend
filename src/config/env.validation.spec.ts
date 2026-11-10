import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.validation.js';

const base = {
  DATABASE_URL: 'postgres://localhost/test',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
};

describe('validateEnv', () => {
  it('applies defaults', () => {
    const env = validateEnv(base);
    expect(env.PORT).toBe(4000);
    expect(env.APP_NAME).toBe('fysi');
    expect(env.SWAGGER_ENABLED).toBe(false);
  });

  it('parses strings from the environment', () => {
    const env = validateEnv({
      ...base,
      PORT: '8080',
      SWAGGER_ENABLED: 'true',
      RATE_LIMIT_REFILL_PER_SEC: '0.5',
    });
    expect(env.PORT).toBe(8080);
    expect(env.SWAGGER_ENABLED).toBe(true);
    expect(env.RATE_LIMIT_REFILL_PER_SEC).toBe(0.5);
  });

  it('names the setting when a URL holds something else, e.g. a key pasted in the wrong box', () => {
    expect(() =>
      validateEnv({ ...base, S3_ENDPOINT: '0fb5ebb4c3b4484a5fb56bd615e85795' }),
    ).toThrow(/S3_ENDPOINT must be empty or an https:\/\/ URL/);
    expect(() =>
      validateEnv({ ...base, REDIS_URL: 'https://x.upstash.io' }),
    ).toThrow(/REDIS_URL must be a redis:\/\/ or rediss:\/\/ URL/);
    expect(() =>
      validateEnv({ ...base, DATABASE_URL: 'db.example.com' }),
    ).toThrow(/DATABASE_URL must be a postgresql:\/\/ connection string/);
    expect(
      validateEnv({
        ...base,
        S3_ENDPOINT: 'https://ref.storage.supabase.co/storage/v1/s3',
        REDIS_URL: 'rediss://default:pw@x.upstash.io:6379',
        DATABASE_URL: 'postgresql://u:p@host:5432/postgres?sslmode=require',
      }).S3_ENDPOINT,
    ).toBe('https://ref.storage.supabase.co/storage/v1/s3');
  });

  it('requires a 32-byte encryption key and a known role list for 2FA', () => {
    expect(() =>
      validateEnv({ ...base, DATA_ENCRYPTION_KEY: 'too-short' }),
    ).toThrow(/DATA_ENCRYPTION_KEY must be 32 random bytes/);
    expect(() => validateEnv({ ...base, MFA_REQUIRED_ROLES: 'builder' })).toThrow(
      /MFA_REQUIRED_ROLES/,
    );
    expect(validateEnv({ ...base, MFA_REQUIRED_ROLES: '' }).MFA_REQUIRED_ROLES).toBe('');
  });

  it('reads booleans with stray spaces or capitals', () => {
    const env = (v: string) =>
      validateEnv({ ...base, MAIL_CONSOLE_IN_PRODUCTION: v })
        .MAIL_CONSOLE_IN_PRODUCTION;
    expect(env(' true ')).toBe(true);
    expect(env('TRUE')).toBe(true);
    expect(env('1')).toBe(true);
    expect(env('no')).toBe(false);
  });

  it('accepts only the Stellar testnet', () => {
    expect(validateEnv(base).STELLAR_NETWORK).toBe('testnet');
    expect(() => validateEnv({ ...base, STELLAR_NETWORK: 'mainnet' })).toThrow(
      /STELLAR_NETWORK must be testnet/,
    );
  });

  it('rejects a missing database URL and a short JWT secret', () => {
    expect(() =>
      validateEnv({
        ...base,
        DATABASE_URL: undefined,
        JWT_ACCESS_SECRET: 'short',
      }),
    ).toThrow(/DATABASE_URL[\s\S]*JWT_ACCESS_SECRET/);
  });
});
