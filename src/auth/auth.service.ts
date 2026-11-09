import { v7 } from 'uuid';
import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { hash, verify } from '@node-rs/argon2';
import { recordAudit } from '../audit/audit.queries.js';
import { RetryAfterException } from '../common/retry-after.exception.js';
import { SecretBox } from '../common/secret-box.js';
import type { EnvVars } from '../config/env.validation.js';
import { Database, type Tx } from '../database/database.js';
import {
  isStaff,
  type OtpPurpose,
  type Role,
} from '../database/schema/index.js';
import { MailService } from '../mail/mail.service.js';
import { imageUrl } from '../storage/images.js';
import { ObjectStorage } from '../storage/object-storage.js';
import {
  deleteUnverifiedHolder,
  findUserByEmail,
  findUserById,
  insertUser,
  isSuspended,
  lockUser,
  updateUser,
} from '../users/users.queries.js';
import { findVendorSummary, insertVendor } from '../vendors/vendors.queries.js';
import {
  consumeRefreshToken,
  deleteExpiredForUser,
  deleteFamiliesForUser,
  deleteFamily,
  deleteOtp,
  findRefreshTokenOwner,
  findUsedRefreshToken,
  insertRefreshToken,
  lockOtp,
  markEmailVerified,
  markRefreshTokenUsed,
  recordOtpMiss,
  setTotp,
  updatePasswordHash,
  upsertOtp,
} from './auth.queries.js';
import type { AuthUser } from './auth-user.js';
import type {
  AuthTokensDto,
  ChangePasswordDto,
  DisableTwoFactorDto,
  EmailDto,
  LoginDto,
  LoginResultDto,
  MeDto,
  OtpIssuedDto,
  RegisterDto,
  RegisterResultDto,
  ResetPasswordDto,
  TwoFactorLoginDto,
  TwoFactorSetupDto,
  UpdateProfileDto,
  VerifyEmailDto,
} from './dto/auth.dto.js';
import { MfaPolicy } from './mfa.policy.js';
import {
  generateOtp,
  hashOtp,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_MS,
  otpMatches,
} from './otp.js';
import { generateTotpSecret, otpauthUrl, verifyTotp } from './totp.js';

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

type RefreshOutcome =
  | { kind: 'ok'; tokens: AuthTokensDto }
  | { kind: 'invalid' }
  | { kind: 'reuse' };

/** `admin_invite` is a reset code sent with the welcome mail. */
type MailKind = OtpPurpose | 'admin_invite';

interface PendingOtp {
  email: string;
  code: string;
  kind: MailKind;
}

/** Audience of the short-lived token between the password and the 2FA code. */
export const MFA_LOGIN_AUDIENCE = 'mfa-login';
const MFA_LOGIN_TTL_SECONDS = 300;
const TOTP_ISSUER = 'Fysi';

export const totpContext = (userId: string) => `totp:${userId}`;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly accessTtlSeconds: number;
  private readonly otpTtlMs: number;
  private readonly otpSecret: string;
  private readonly refreshTtlMs: number;
  private readonly staffIdleMs: number;
  // Verified against when the email is unknown, to keep timing uniform.
  private readonly dummyHash: Promise<string>;

  constructor(
    private readonly database: Database,
    private readonly jwt: JwtService,
    private readonly mail: MailService,
    private readonly storage: ObjectStorage,
    private readonly box: SecretBox,
    private readonly mfa: MfaPolicy,
    config: ConfigService<EnvVars, true>,
  ) {
    this.accessTtlSeconds = config.get('ACCESS_TOKEN_TTL_SECONDS', {
      infer: true,
    });
    this.otpTtlMs = config.get('OTP_TTL_MINUTES', { infer: true }) * 60_000;
    this.otpSecret = config.get('JWT_ACCESS_SECRET', { infer: true });
    this.refreshTtlMs =
      config.get('REFRESH_TOKEN_TTL_DAYS', { infer: true }) * 86_400_000;
    this.staffIdleMs =
      config.get('ADMIN_SESSION_IDLE_MINUTES', { infer: true }) * 60_000;
    this.dummyHash = hash(randomBytes(16).toString('hex'));
  }

  async register(dto: RegisterDto): Promise<RegisterResultDto> {
    const role = dto.accountType ?? 'customer';
    const passwordHash = await hash(dto.password);
    const pending = await this.database.transaction(async (tx) => {
      const replaced = await deleteUnverifiedHolder(tx, dto.email);
      if (replaced.length > 0)
        await recordAudit(tx, {
          action: 'auth.unverified_replaced',
          metadata: { replacedUserIds: replaced },
        });
      const user = await insertUser(tx, {
        email: dto.email,
        passwordHash,
        role,
        name: dto.name,
        phone: dto.phone,
      });
      // Vendors start with an empty business profile in draft (PRD V2 wizard).
      if (role === 'vendor')
        await insertVendor(tx, {
          userId: user.id,
          businessName: dto.businessName,
        });
      await recordAudit(tx, {
        action: 'auth.register',
        actorId: user.id,
        resourceType: 'user',
        resourceId: user.id,
        metadata: { role },
      });
      return this.issueOtp(tx, user.id, user.email, 'verify_email');
    });
    void this.deliverOtp(pending);
    return {
      email: dto.email,
      accountType: role,
      otpExpiresInSeconds: this.otpTtlMs / 1000,
      resendAfterSeconds: OTP_RESEND_COOLDOWN_MS / 1000,
    };
  }

  /**
   * Creates a verified admin with a password nobody knows and mails a reset code, so the
   * new admin picks their own password and no secret travels through the creator.
   */
  async createAdmin(actor: AuthUser, input: { email: string; name: string }) {
    const passwordHash = await hash(randomBytes(32).toString('hex'));
    const { user, pending } = await this.database.transaction(async (tx) => {
      const created = await insertUser(tx, {
        ...input,
        passwordHash,
        role: 'admin',
        emailVerifiedAt: new Date(),
      });
      await recordAudit(tx, {
        action: 'admin.created',
        actorId: actor.id,
        resourceType: 'user',
        resourceId: created.id,
        after: { email: created.email, name: created.name, role: 'admin' },
      });
      const otp = await this.issueOtp(
        tx,
        created.id,
        created.email,
        'reset_password',
      );
      return {
        user: created,
        pending: { ...otp, kind: 'admin_invite' as const },
      };
    });
    void this.deliverOtp(pending);
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      createdAt: user.createdAt,
      otpExpiresInSeconds: this.otpTtlMs / 1000,
    };
  }

  async resendOtp(dto: EmailDto): Promise<OtpIssuedDto> {
    const result = this.otpIssued();
    const user = await findUserByEmail(this.database.db, dto.email);
    if (!user || user.emailVerifiedAt) return result;
    const pending = await this.database.transaction((tx) =>
      this.issueOtp(tx, user.id, user.email, 'verify_email'),
    );
    void this.deliverOtp(pending);
    return result;
  }

  async verifyEmail(dto: VerifyEmailDto): Promise<AuthTokensDto> {
    const user = await findUserByEmail(this.database.db, dto.email);
    if (!user || user.emailVerifiedAt) throw this.invalidCode();

    const tokens = await this.database.transaction(
      async (tx): Promise<AuthTokensDto | undefined> => {
        await lockUser(tx, user.id, 'share');
        if (await isSuspended(tx, user.id))
          throw new ForbiddenException('Account suspended');
        if (!(await this.consumeOtp(tx, user.id, 'verify_email', dto.otp)))
          return undefined;
        await markEmailVerified(tx, user.id);
        await recordAudit(tx, {
          action: 'auth.email_verified',
          actorId: user.id,
        });
        return this.issueTokens(tx, user.id, user.role, v7(), false);
      },
    );
    if (!tokens) throw this.invalidCode();
    return tokens;
  }

  async forgotPassword(dto: EmailDto): Promise<OtpIssuedDto> {
    const result = this.otpIssued();
    const user = await findUserByEmail(this.database.db, dto.email);
    if (!user || !user.emailVerifiedAt) return result;
    const pending = await this.database.transaction((tx) =>
      this.issueOtp(tx, user.id, user.email, 'reset_password'),
    );
    void this.deliverOtp(pending);
    return result;
  }

  /** Resets the password only: an account with 2FA still needs its authenticator to sign in. */
  async resetPassword(dto: ResetPasswordDto): Promise<void> {
    // Hashed before the lookup so unknown emails cost the same time.
    const passwordHash = await hash(dto.newPassword);
    const user = await findUserByEmail(this.database.db, dto.email);
    if (!user) throw this.invalidCode();
    const done = await this.database.transaction(async (tx) => {
      await lockUser(tx, user.id, 'update');
      if (!(await this.consumeOtp(tx, user.id, 'reset_password', dto.otp)))
        return false;
      await updatePasswordHash(tx, user.id, passwordHash);
      await deleteFamiliesForUser(tx, user.id);
      await recordAudit(tx, {
        action: 'auth.password_reset',
        actorId: user.id,
      });
      return true;
    });
    if (!done) throw this.invalidCode();
  }

  async changePassword(
    authUser: AuthUser,
    dto: ChangePasswordDto,
  ): Promise<void> {
    const passwordHash = await hash(dto.newPassword);
    await this.database.transaction(async (tx) => {
      const user = await lockUser(tx, authUser.id, 'update');
      if (!user) throw new UnauthorizedException();
      if (!(await verify(user.passwordHash, dto.currentPassword)))
        throw new BadRequestException('Current password is incorrect');
      await updatePasswordHash(tx, user.id, passwordHash);
      await deleteFamiliesForUser(tx, user.id, authUser.familyId);
      await recordAudit(tx, {
        action: 'auth.password_changed',
        actorId: user.id,
      });
    });
  }

  async logoutAll(userId: string): Promise<void> {
    await this.database.transaction(async (tx) => {
      await lockUser(tx, userId, 'update');
      await deleteFamiliesForUser(tx, userId);
      await recordAudit(tx, { action: 'auth.logout_all', actorId: userId });
    });
  }

  async updateProfile(
    authUser: AuthUser,
    dto: UpdateProfileDto,
  ): Promise<MeDto> {
    const changes = Object.fromEntries(
      Object.entries(dto).filter(([, v]) => v !== undefined),
    ) as Partial<{ name: string; phone: string | null }>;
    if (Object.keys(changes).length === 0)
      throw new BadRequestException('No fields to update');
    await this.database.transaction(async (tx) => {
      await updateUser(tx, authUser.id, changes);
      await recordAudit(tx, {
        action: 'auth.profile_updated',
        actorId: authUser.id,
        metadata: { fields: Object.keys(changes) },
      });
    });
    return this.me(authUser.id);
  }

  /**
   * Password step. Accounts with 2FA get a short-lived `mfaToken` instead of
   * tokens and finish at `POST /auth/login/2fa`.
   */
  async login(dto: LoginDto): Promise<LoginResultDto> {
    const user = await findUserByEmail(this.database.db, dto.email);
    const valid = await verify(
      user?.passwordHash ?? (await this.dummyHash),
      dto.password,
    );
    if (!user || !valid) {
      await this.database.transaction((tx) =>
        recordAudit(tx, {
          action: 'auth.login_failed',
          metadata: { email: dto.email },
        }),
      );
      throw new UnauthorizedException('Invalid credentials');
    }
    if (!user.emailVerifiedAt)
      throw new ForbiddenException('Email not verified');

    if (user.totpEnabledAt) {
      if (await isSuspended(this.database.db, user.id))
        throw new ForbiddenException('Account suspended');
      const mfaToken = await this.jwt.signAsync(
        { sub: user.id, ph: sha256(user.passwordHash).slice(0, 16) },
        { audience: MFA_LOGIN_AUDIENCE, expiresIn: MFA_LOGIN_TTL_SECONDS },
      );
      return {
        mfaRequired: true,
        mfaToken,
        mfaTokenExpiresIn: MFA_LOGIN_TTL_SECONDS,
      };
    }

    const tokens = await this.database.transaction(async (tx) => {
      // A reset or password change may have committed since the check above.
      const locked = await lockUser(tx, user.id, 'share');
      if (locked?.passwordHash !== user.passwordHash)
        throw new UnauthorizedException('Invalid credentials');
      if (await isSuspended(tx, user.id))
        throw new ForbiddenException('Account suspended');
      await deleteExpiredForUser(tx, user.id);
      await recordAudit(tx, { action: 'auth.login', actorId: user.id });
      return this.issueTokens(tx, user.id, user.role, v7(), false);
    });
    return { mfaRequired: false, ...tokens };
  }

  /** Second step: the code from the authenticator app. One code signs in once. */
  async loginTwoFactor(dto: TwoFactorLoginDto): Promise<AuthTokensDto> {
    let payload: { sub?: unknown; ph?: unknown };
    try {
      payload = await this.jwt.verifyAsync(dto.mfaToken, {
        audience: MFA_LOGIN_AUDIENCE,
        algorithms: ['HS256'],
      });
    } catch {
      throw new UnauthorizedException(
        'Sign-in expired. Enter your email and password again',
      );
    }
    if (typeof payload.sub !== 'string') throw new UnauthorizedException();
    const userId = payload.sub;

    const tokens = await this.database.transaction(async (tx) => {
      const user = await lockUser(tx, userId, 'update');
      // A password change since the first step voids the token.
      if (
        !user?.totpEnabledAt ||
        !user.totpSecret ||
        sha256(user.passwordHash).slice(0, 16) !== payload.ph
      )
        throw new UnauthorizedException(
          'Sign-in expired. Enter your email and password again',
        );
      if (await isSuspended(tx, user.id))
        throw new ForbiddenException('Account suspended');
      const secret = this.box.open(user.totpSecret, totpContext(user.id));
      const step = verifyTotp(secret, dto.code, user.totpLastStep);
      if (step === null) return undefined;
      await setTotp(tx, user.id, { totpLastStep: step });
      await deleteExpiredForUser(tx, user.id);
      await recordAudit(tx, {
        action: 'auth.login',
        actorId: user.id,
        metadata: { mfa: true },
      });
      return this.issueTokens(tx, user.id, user.role, v7(), true);
    });
    if (!tokens) {
      await this.database.transaction((tx) =>
        recordAudit(tx, { action: 'auth.mfa_failed', actorId: userId }),
      );
      throw new BadRequestException('Invalid or expired code');
    }
    return tokens;
  }

  /**
   * Starts (or restarts) 2FA setup with a fresh secret. Nothing changes for
   * sign-in until `enableTwoFactor` confirms a code from the app.
   */
  async setupTwoFactor(authUser: AuthUser): Promise<TwoFactorSetupDto> {
    const secret = generateTotpSecret();
    const email = await this.database.transaction(async (tx) => {
      const user = await lockUser(tx, authUser.id, 'update');
      if (!user) throw new UnauthorizedException();
      if (user.totpEnabledAt)
        throw new ConflictException('Two-factor sign-in is already on');
      await setTotp(tx, user.id, {
        totpSecret: this.box.seal(secret, totpContext(user.id)),
        totpLastStep: null,
      });
      return user.email;
    });
    return {
      secret,
      otpauthUrl: otpauthUrl(TOTP_ISSUER, email, secret),
    };
  }

  /**
   * Confirms the app works, turns 2FA on, signs out every other session and
   * returns a new token pair for this one, now marked as 2FA-verified.
   */
  async enableTwoFactor(
    authUser: AuthUser,
    code: string,
  ): Promise<AuthTokensDto> {
    const tokens = await this.database.transaction(async (tx) => {
      const user = await lockUser(tx, authUser.id, 'update');
      if (!user) throw new UnauthorizedException();
      if (user.totpEnabledAt)
        throw new ConflictException('Two-factor sign-in is already on');
      if (!user.totpSecret)
        throw new BadRequestException(
          'Start with POST /auth/2fa/setup to get a secret',
        );
      const secret = this.box.open(user.totpSecret, totpContext(user.id));
      const step = verifyTotp(secret, code, null);
      if (step === null) return undefined;
      await setTotp(tx, user.id, {
        totpEnabledAt: new Date(),
        totpLastStep: step,
      });
      await deleteFamiliesForUser(tx, user.id);
      await recordAudit(tx, { action: 'auth.mfa_enabled', actorId: user.id });
      return this.issueTokens(tx, user.id, user.role, v7(), true);
    });
    if (!tokens) throw new BadRequestException('Invalid or expired code');
    return tokens;
  }

  /** Customers may turn 2FA off; roles that require it cannot. */
  async disableTwoFactor(
    authUser: AuthUser,
    dto: DisableTwoFactorDto,
  ): Promise<void> {
    if (this.mfa.requiredFor(authUser.role))
      throw new ForbiddenException(
        'Two-factor sign-in is required for your account type',
      );
    const ok = await this.database.transaction(async (tx) => {
      const user = await lockUser(tx, authUser.id, 'update');
      if (!user) throw new UnauthorizedException();
      if (!user.totpEnabledAt || !user.totpSecret)
        throw new ConflictException('Two-factor sign-in is not on');
      if (!(await verify(user.passwordHash, dto.password))) return false;
      const secret = this.box.open(user.totpSecret, totpContext(user.id));
      if (verifyTotp(secret, dto.code, user.totpLastStep) === null)
        return false;
      await setTotp(tx, user.id, {
        totpSecret: null,
        totpEnabledAt: null,
        totpLastStep: null,
      });
      await deleteFamiliesForUser(tx, user.id, authUser.familyId);
      await recordAudit(tx, { action: 'auth.mfa_disabled', actorId: user.id });
      return true;
    });
    if (!ok) throw new BadRequestException('Password or code is incorrect');
  }

  async refresh(refreshToken: string): Promise<AuthTokensDto> {
    const tokenHash = sha256(refreshToken);
    // A throw inside the transaction would roll back the family revocation,
    // so the outcome is returned and acted on after commit.
    const outcome = await this.database.transaction(
      async (tx): Promise<RefreshOutcome> => {
        // User lock first, as revokers do, so rotation cannot outlive a revoke.
        const ownerId = await findRefreshTokenOwner(tx, tokenHash);
        if (ownerId) await lockUser(tx, ownerId, 'share');
        const row = await consumeRefreshToken(tx, tokenHash);
        if (!row) {
          const used = await findUsedRefreshToken(tx, tokenHash);
          if (!used) return { kind: 'invalid' };
          await deleteFamily(tx, used.familyId);
          await recordAudit(tx, {
            action: 'auth.refresh_reuse_detected',
            resourceType: 'refresh_token_family',
            resourceId: used.familyId,
          });
          return { kind: 'reuse' };
        }
        if (row.expiresAt.getTime() <= Date.now()) return { kind: 'invalid' };

        await markRefreshTokenUsed(tx, {
          tokenHash,
          familyId: row.familyId,
        });
        const user = await findUserById(tx, row.userId);
        if (!user) return { kind: 'invalid' };
        await recordAudit(tx, { action: 'auth.refresh', actorId: row.userId });
        return {
          kind: 'ok',
          tokens: await this.issueTokens(
            tx,
            user.id,
            user.role,
            row.familyId,
            row.mfa,
          ),
        };
      },
    );
    if (outcome.kind !== 'ok') throw new UnauthorizedException();
    return outcome.tokens;
  }

  async logout(refreshToken: string): Promise<void> {
    const tokenHash = sha256(refreshToken);
    await this.database.transaction(async (tx) => {
      const row = await consumeRefreshToken(tx, tokenHash);
      if (!row) return;
      await deleteFamily(tx, row.familyId);
      await recordAudit(tx, { action: 'auth.logout', actorId: row.userId });
    });
  }

  async me(userId: string): Promise<MeDto> {
    const user = await findUserById(this.database.db, userId);
    if (!user) throw new UnauthorizedException();
    const vendor =
      user.role === 'vendor'
        ? ((await findVendorSummary(this.database.db, userId)) ?? null)
        : null;
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      phone: user.phone,
      avatarUrl: await imageUrl(this.storage, user.avatarKey),
      twoFactorEnabled: user.totpEnabledAt !== null,
      twoFactorRequired: this.mfa.requiredFor(user.role),
      vendor,
      createdAt: user.createdAt,
    };
  }

  private invalidCode() {
    return new BadRequestException('Invalid or expired code');
  }

  private otpIssued(): OtpIssuedDto {
    return {
      otpExpiresInSeconds: this.otpTtlMs / 1000,
      resendAfterSeconds: OTP_RESEND_COOLDOWN_MS / 1000,
    };
  }

  /** Stores a fresh code. Throws RetryAfterException when one was issued within the cooldown. */
  private async issueOtp(
    tx: Tx,
    userId: string,
    email: string,
    purpose: OtpPurpose,
  ): Promise<PendingOtp> {
    const code = generateOtp();
    const stored = await upsertOtp(
      tx,
      {
        userId,
        purpose,
        codeHash: hashOtp(this.otpSecret, purpose, userId, code),
        expiresAt: new Date(Date.now() + this.otpTtlMs),
      },
      new Date(Date.now() - OTP_RESEND_COOLDOWN_MS),
    );
    if (!stored) {
      const current = await lockOtp(tx, userId, purpose);
      const elapsed = current ? Date.now() - current.createdAt.getTime() : 0;
      throw new RetryAfterException(
        'Wait before requesting another code',
        Math.max(1, Math.ceil((OTP_RESEND_COOLDOWN_MS - elapsed) / 1000)),
      );
    }
    return { email, code, kind: purpose };
  }

  /**
   * True when the code is right; the code is then spent. A wrong guess is
   * counted and returns false, never throws, so the count survives commit.
   */
  private async consumeOtp(
    tx: Tx,
    userId: string,
    purpose: OtpPurpose,
    code: string,
  ): Promise<boolean> {
    const otp = await lockOtp(tx, userId, purpose);
    if (!otp) return false;
    if (otp.expiresAt.getTime() <= Date.now()) {
      await deleteOtp(tx, userId, purpose);
      return false;
    }
    const matches = otpMatches(
      otp.codeHash,
      hashOtp(this.otpSecret, purpose, userId, code),
    );
    if (matches) await deleteOtp(tx, userId, purpose);
    else if (otp.attempts + 1 >= OTP_MAX_ATTEMPTS)
      await deleteOtp(tx, userId, purpose);
    else await recordOtpMiss(tx, userId, purpose);
    return matches;
  }

  /**
   * Runs after commit and is not awaited, so response time does not reveal
   * whether a mail was sent. A failure leaves the account usable: the user can resend.
   */
  private async deliverOtp(pending: PendingOtp): Promise<void> {
    const ttlMinutes = this.otpTtlMs / 60_000;
    try {
      if (pending.kind === 'verify_email')
        await this.mail.sendVerificationCode(
          pending.email,
          pending.code,
          ttlMinutes,
        );
      else if (pending.kind === 'admin_invite')
        await this.mail.sendAdminInvite(
          pending.email,
          pending.code,
          ttlMinutes,
        );
      else
        await this.mail.sendPasswordResetCode(
          pending.email,
          pending.code,
          ttlMinutes,
        );
    } catch (err) {
      this.logger.error(
        { err, kind: pending.kind },
        'Failed to send OTP email',
      );
    }
  }

  /**
   * Staff sessions are short and idle out (`ADMIN_SESSION_IDLE_MINUTES`); each
   * refresh restarts the clock. Other accounts use `REFRESH_TOKEN_TTL_DAYS`.
   */
  private async issueTokens(
    tx: Tx,
    userId: string,
    role: Role,
    familyId: string,
    mfa: boolean,
  ): Promise<AuthTokensDto> {
    const refreshToken = randomBytes(32).toString('base64url');
    const ttl = isStaff(role) ? this.staffIdleMs : this.refreshTtlMs;
    await insertRefreshToken(tx, {
      tokenHash: sha256(refreshToken),
      familyId,
      userId,
      mfa,
      expiresAt: new Date(Date.now() + ttl),
    });
    const accessToken = await this.jwt.signAsync({
      sub: userId,
      role,
      fid: familyId,
      mfa,
    });
    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.accessTtlSeconds,
      role,
      mfa,
      twoFactorSetupRequired: !mfa && this.mfa.requiredFor(role),
    };
  }
}
