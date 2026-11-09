import { plainToInstance, Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsString,
  Max,
  Min,
  Matches,
  MinLength,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

export enum LogLevel {
  Fatal = 'fatal',
  Error = 'error',
  Warn = 'warn',
  Info = 'info',
  Debug = 'debug',
  Trace = 'trace',
  Silent = 'silent',
}

export enum StellarNetwork {
  Testnet = 'testnet',
  Mainnet = 'mainnet',
}

const toBoolean = ({ value }: { value: unknown }) =>
  value === true || value === 'true';

export class EnvVars {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT = 4000;

  /** JWT issuer and OpenAPI title. */
  @IsString()
  @IsNotEmpty()
  APP_NAME = 'fysi';

  @IsEnum(LogLevel)
  LOG_LEVEL: LogLevel = LogLevel.Info;

  /** Runtime connection. On Supabase use the session pooler (port 5432); see docs/DATABASE.md. */
  @IsString()
  @IsNotEmpty()
  @Matches(/^postgres(ql)?:\/\/\S+$/, {
    message: 'DATABASE_URL must be a postgresql:// connection string',
  })
  DATABASE_URL: string;

  /** Optional separate connection for `pnpm db:migrate`; falls back to DATABASE_URL. */
  @IsString()
  DATABASE_MIGRATION_URL = '';

  /** Kept small: Supabase's free session pooler caps client connections. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  DB_POOL_MAX = 5;

  /** Times the API pings Postgres on boot before giving up and exiting. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  DB_STARTUP_ATTEMPTS = 5;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  DB_STATEMENT_TIMEOUT_MS = 15000;

  @IsString()
  @IsNotEmpty()
  @Matches(/^rediss?:\/\/\S+$/, {
    message: 'REDIS_URL must be a redis:// or rediss:// URL',
  })
  REDIS_URL: string;

  @IsString()
  @MinLength(32)
  JWT_ACCESS_SECRET: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  ACCESS_TOKEN_TTL_SECONDS = 900;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  REFRESH_TOKEN_TTL_DAYS = 30;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  OTP_TTL_MINUTES = 10;

  /** Empty uses the console mailer, which is refused in production. */
  @IsString()
  RESEND_API_KEY = '';

  /** Required with RESEND_API_KEY; must be on a domain verified in Resend. */
  @IsString()
  MAIL_FROM = '';

  /**
   * Staging only: send every email to this one address (the Resend account
   * owner while using the test sender). Empty sends to the real recipient.
   */
  @Matches(/^(\S+@\S+\.\S+)?$/, {
    message: 'MAIL_REDIRECT_TO must be empty or an email address',
  })
  MAIL_REDIRECT_TO = '';

  /**
   * Staging only: lets a production build print mail to the logs when no
   * RESEND_API_KEY is set. Never enable on the real launch server.
   */
  @Transform(toBoolean)
  @IsBoolean()
  MAIL_CONSOLE_IN_PRODUCTION = false;

  /** S3-compatible bucket (Supabase Storage works). Empty disables image upload and display. */
  @IsString()
  S3_BUCKET = '';

  @IsString()
  @Matches(/^(https?:\/\/\S+)?$/, {
    message:
      'S3_ENDPOINT must be empty or an https:// URL (the Supabase S3 endpoint), not a key',
  })
  S3_ENDPOINT = '';

  @IsString()
  S3_REGION = 'auto';

  @IsString()
  S3_ACCESS_KEY_ID = '';

  @IsString()
  S3_SECRET_ACCESS_KEY = '';

  /** Supabase Storage needs path-style URLs (true). */
  @Transform(toBoolean)
  @IsBoolean()
  S3_FORCE_PATH_STYLE = false;

  /** Lifetime of the presigned image URLs the API returns. */
  @Type(() => Number)
  @IsInt()
  @Min(60)
  S3_DOWNLOAD_TTL_SECONDS = 3600;

  /** Comma-separated allowlist. Empty (with no FRONTEND_URL) disables CORS. */
  @IsString()
  CORS_ORIGINS = '';

  /** Main frontend address, e.g. https://fysi.ng. Allowed by CORS and used in email links. */
  @IsString()
  @Matches(/^(https?:\/\/\S+)?$/, {
    message: 'FRONTEND_URL must be empty or an http(s):// address',
  })
  FRONTEND_URL = '';

  @IsEnum(StellarNetwork)
  STELLAR_NETWORK: StellarNetwork = StellarNetwork.Testnet;

  /** Must be true for STELLAR_NETWORK=mainnet: real money needs a deliberate switch. */
  @Transform(toBoolean)
  @IsBoolean()
  STELLAR_ALLOW_MAINNET = false;

  /** Empty uses SDF's public Horizon for the chosen network. */
  @IsString()
  @Matches(/^(https?:\/\/\S+)?$/, {
    message: 'STELLAR_HORIZON_URL must be empty or an https:// URL',
  })
  STELLAR_HORIZON_URL = '';

  /**
   * Settlement asset allowlist: `CODE:ISSUER`. Fysi settles in USDC only (PRD
   * decision); look up Circle's issuer for the network in use.
   */
  @IsString()
  @IsNotEmpty()
  STELLAR_ASSETS = 'XLM';

  /**
   * Secret key (S...) of the platform's signing account. Phase 2 (payments) moves
   * custody to the wallet service; nothing in phase 1 signs with it.
   */
  @IsString()
  STELLAR_PLATFORM_SECRET = '';

  /**
   * 32-byte key (base64) that encrypts sensitive columns at rest: two-factor
   * secrets and vendor director ID numbers. Losing it makes them unreadable.
   * Generate: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   */
  @Matches(/^[A-Za-z0-9+/]{43}=$/, {
    message:
      'DATA_ENCRYPTION_KEY must be 32 random bytes, base64-encoded (44 characters)',
  })
  DATA_ENCRYPTION_KEY: string;

  /** Roles that must turn on two-factor sign-in before using the API (PRD: vendors and admins). */
  @Matches(/^((customer|vendor|admin|super_admin)(,(customer|vendor|admin|super_admin))*)?$/, {
    message:
      'MFA_REQUIRED_ROLES must be a comma-separated list of customer, vendor, admin, super_admin',
  })
  MFA_REQUIRED_ROLES = 'vendor,admin,super_admin';

  /**
   * Admin sessions end after this many minutes without a token refresh
   * (customers and vendors use REFRESH_TOKEN_TTL_DAYS).
   */
  @Type(() => Number)
  @IsInt()
  @Min(5)
  ADMIN_SESSION_IDLE_MINUTES = 60;

  /**
   * Who holds custodial keys. `local`: keys encrypted with DATA_ENCRYPTION_KEY
   * in this database, testnet only (refused on mainnet). An MPC provider such
   * as DFNS plugs in behind the same interface for the pilot.
   */
  @IsIn(['local'])
  WALLET_PROVIDER = 'local';

  /** Minutes a checkout holds stock and its QR code and link stay valid (PRD: 15). */
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(120)
  PAYMENT_WINDOW_MINUTES = 15;

  /** Hours a partly paid order stays open for the balance before it expires and is refunded. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  PARTIAL_PAYMENT_GRACE_HOURS = 24;

  /** Platform commission in basis points (PRD: 5% = 500). */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(5000)
  COMMISSION_BPS = 500;

  /** Days after approval that founding vendors pay no commission (PRD: 3 months). */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  FOUNDING_VENDOR_FREE_DAYS = 90;

  /** Escrow releases this many days after Shipped if the customer does nothing (PRD: 7). */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  ESCROW_AUTO_RELEASE_DAYS = 7;

  /** Days after delivery a customer can report a problem (PRD: 7). */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  PROBLEM_REPORT_DAYS = 7;

  /** Milliseconds between payment-watcher polls of the settlement account. 0 turns it off. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  WATCHER_INTERVAL_MS = 3000;

  /** Seconds between sweeps (expire orders, release escrow, retry wallets and transfers). 0 turns it off. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  SWEEP_INTERVAL_SECONDS = 30;

  /** Most a vendor can withdraw per rolling 24 hours, in US cents. */
  @Type(() => Number)
  @IsInt()
  @Min(100)
  WITHDRAWAL_DAILY_LIMIT_CENTS = 100_000;

  /** KYC Tier 1 customer wallet balance cap, in US cents (PRD: ₦300,000 ≈ $200). */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  CUSTOMER_TIER1_CAP_CENTS = 20_000;

  /** Number of reverse proxies in front of the app (Render = 1). */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  TRUST_PROXY_HOPS = 0;

  @Transform(toBoolean)
  @IsBoolean()
  SWAGGER_ENABLED = false;

  @Type(() => Number)
  @IsNumber()
  @Min(1)
  RATE_LIMIT_CAPACITY = 60;

  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  RATE_LIMIT_REFILL_PER_SEC = 1;
}

export function validateEnv(raw: Record<string, unknown>): EnvVars {
  const env = plainToInstance(EnvVars, raw, { exposeDefaultValues: true });
  const errors = validateSync(env, { whitelist: false });
  if (errors.length > 0) {
    const lines = errors.map(
      (e) => `${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`,
    );
    // One line: hosts like Render show each log line separately.
    throw new Error(`Invalid environment: ${lines.join(' | ')}`);
  }
  return env;
}
