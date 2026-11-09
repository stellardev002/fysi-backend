import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  roleEnum,
  type Role,
  vendorStatusEnum,
  type VendorStatus,
} from '../../database/schema/index.js';

export const normaliseEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Empty strings clear an optional field. */
export const trimOrNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || null : value;

/** E.164, e.g. +2348031234567. Spaces and dashes are stripped first. */
export const PHONE = /^\+[1-9]\d{7,14}$/;
export const normalisePhone = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.replace(/[\s-]/g, '') || null : value;

export const EMAIL_DOC = {
  description: 'Trimmed and lower-cased before use.',
  example: 'aisha@ecothreads.ng',
  maxLength: 254,
};

const OTP_DOC = {
  description:
    '6-digit code from the email. Expires after `otpExpiresInSeconds`; five wrong attempts burn it.',
  example: '482913',
  pattern: '^\\d{6}$',
};

const TOTP_DOC = {
  description: '6-digit code from the authenticator app.',
  example: '204816',
  pattern: '^\\d{6}$',
};

export const PASSWORD_MIN = 8;

export const ACCOUNT_TYPES = ['customer', 'vendor'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export class RegisterDto {
  @ApiPropertyOptional({
    enum: ACCOUNT_TYPES,
    default: 'customer',
    description:
      '`customer` to shop (the default, used at checkout). `vendor` to sell: the account starts a business profile in draft, to complete and submit for verification.',
  })
  @IsOptional()
  @IsIn(ACCOUNT_TYPES)
  accountType?: AccountType;

  @ApiProperty({ example: 'Aisha Musa', maxLength: 100 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @ApiProperty(EMAIL_DOC)
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty({
    minLength: PASSWORD_MIN,
    maxLength: 128,
    example: 'correct-horse-battery',
  })
  @IsString()
  @MinLength(PASSWORD_MIN)
  @MaxLength(128)
  password: string;

  @ApiPropertyOptional({
    example: '+2348031234567',
    description: 'International format. Spaces and dashes are ignored.',
  })
  @IsOptional()
  @Transform(normalisePhone)
  @Matches(PHONE, {
    message: 'phone must be in international format, e.g. +2348031234567',
  })
  phone?: string;

  @ApiPropertyOptional({
    example: 'EcoThreads Lagos',
    maxLength: 120,
    description:
      'Vendors only, optional here: the business name can be filled in during onboarding.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  businessName?: string;
}

export class LoginDto {
  @ApiProperty(EMAIL_DOC)
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty({ example: 'correct-horse-battery', maxLength: 128 })
  @IsString()
  @MaxLength(128)
  password: string;
}

export class TwoFactorLoginDto {
  @ApiProperty({
    description: '`mfaToken` from `POST /auth/login`. Valid for 5 minutes.',
  })
  @IsString()
  @MinLength(20)
  @MaxLength(2000)
  mfaToken: string;

  @ApiProperty(TOTP_DOC)
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code: string;
}

export class TwoFactorCodeDto {
  @ApiProperty(TOTP_DOC)
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code: string;
}

export class DisableTwoFactorDto extends TwoFactorCodeDto {
  @ApiProperty({ example: 'correct-horse-battery', maxLength: 128 })
  @IsString()
  @MaxLength(128)
  password: string;
}

export class VerifyEmailDto {
  @ApiProperty(EMAIL_DOC)
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty(OTP_DOC)
  @Matches(/^\d{6}$/, { message: 'otp must be 6 digits' })
  otp: string;
}

export class EmailDto {
  @ApiProperty(EMAIL_DOC)
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(254)
  email: string;
}

export class ResetPasswordDto {
  @ApiProperty(EMAIL_DOC)
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty(OTP_DOC)
  @Matches(/^\d{6}$/, { message: 'otp must be 6 digits' })
  otp: string;

  @ApiProperty({
    minLength: PASSWORD_MIN,
    maxLength: 128,
    example: 'a-new-strong-secret',
  })
  @IsString()
  @MinLength(PASSWORD_MIN)
  @MaxLength(128)
  newPassword: string;
}

export class ChangePasswordDto {
  @ApiProperty({ example: 'correct-horse-battery', maxLength: 128 })
  @IsString()
  @MaxLength(128)
  currentPassword: string;

  @ApiProperty({
    minLength: PASSWORD_MIN,
    maxLength: 128,
    example: 'a-new-strong-secret',
  })
  @IsString()
  @MinLength(PASSWORD_MIN)
  @MaxLength(128)
  newPassword: string;
}

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'Aisha Musa', maxLength: 100 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({
    example: '+2348031234567',
    nullable: true,
    description: 'International format. Send `""` or `null` to clear.',
  })
  @IsOptional()
  @Transform(normalisePhone)
  @ValidateIf((_, v) => v !== null)
  @Matches(PHONE, {
    message: 'phone must be in international format, e.g. +2348031234567',
  })
  phone?: string | null;
}

export class RefreshDto {
  @ApiProperty({
    description:
      'Refresh token from sign-in or a previous refresh. Single use: it is replaced on every call.',
    example: 'k3JxV0b8mZ2nQ5uY7wA1cD4eF6gH9iL0oP3rS5tU8vX',
    minLength: 20,
    maxLength: 200,
  })
  @IsString()
  @MinLength(20)
  @MaxLength(200)
  refreshToken: string;
}

export class RegisterResultDto {
  @ApiProperty({
    example: 'aisha@ecothreads.ng',
    description: 'Where the code was sent.',
  })
  email: string;

  @ApiProperty({ enum: ACCOUNT_TYPES })
  accountType: AccountType;

  @ApiProperty({ example: 600, description: 'Seconds until the code expires.' })
  otpExpiresInSeconds: number;

  @ApiProperty({
    example: 60,
    description: 'Seconds before `resend-otp` issues another code.',
  })
  resendAfterSeconds: number;
}

export class OtpIssuedDto {
  @ApiProperty({ example: 600, description: 'Seconds until the code expires.' })
  otpExpiresInSeconds: number;

  @ApiProperty({
    example: 60,
    description: 'Seconds before another code can be requested.',
  })
  resendAfterSeconds: number;
}

export class AuthTokensDto {
  @ApiProperty({
    description: 'Short-lived JWT. Send as `Authorization: Bearer <token>`.',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIwMTk3...',
  })
  accessToken: string;

  @ApiProperty({
    description: 'Opaque, single-use. Exchange at `POST /auth/refresh`.',
    example: 'k3JxV0b8mZ2nQ5uY7wA1cD4eF6gH9iL0oP3rS5tU8vX',
  })
  refreshToken: string;

  @ApiProperty({ enum: ['Bearer'], example: 'Bearer' })
  tokenType: 'Bearer';

  @ApiProperty({
    example: 900,
    description: 'Access token lifetime in seconds.',
  })
  expiresIn: number;

  @ApiProperty({
    enum: roleEnum.enumValues,
    example: 'customer',
    description: 'Lets the client route to the shop, vendor or admin area.',
  })
  role: Role;

  @ApiProperty({ description: 'This session passed two-factor sign-in.' })
  mfa: boolean;

  @ApiProperty({
    description:
      'True for a vendor or admin who has not turned on 2FA yet. Until they do, every route except `/auth/me` and `/auth/2fa/*` answers 403. Send them to 2FA setup.',
  })
  twoFactorSetupRequired: boolean;
}

/**
 * `mfaRequired: false` carries the token fields. `mfaRequired: true` carries
 * only `mfaToken`: finish at `POST /auth/login/2fa`.
 */
export class LoginResultDto {
  @ApiProperty({
    description:
      'True when the account uses 2FA: no tokens yet, send the authenticator code with `mfaToken` to `POST /auth/login/2fa`.',
  })
  mfaRequired: boolean;

  @ApiPropertyOptional({ description: 'Present when `mfaRequired` is true.' })
  mfaToken?: string;

  @ApiPropertyOptional({ example: 300 })
  mfaTokenExpiresIn?: number;

  @ApiPropertyOptional() accessToken?: string;
  @ApiPropertyOptional() refreshToken?: string;
  @ApiPropertyOptional({ enum: ['Bearer'] }) tokenType?: 'Bearer';
  @ApiPropertyOptional() expiresIn?: number;
  @ApiPropertyOptional({ enum: roleEnum.enumValues }) role?: Role;
  @ApiPropertyOptional() mfa?: boolean;
  @ApiPropertyOptional() twoFactorSetupRequired?: boolean;
}

export class TwoFactorSetupDto {
  @ApiProperty({
    example: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
    description:
      'Base32 secret, for typing into the app by hand. Shown once; never stored in the browser.',
  })
  secret: string;

  @ApiProperty({
    example:
      'otpauth://totp/Fysi%3Aaisha%40ecothreads.ng?secret=JBSW...&issuer=Fysi&algorithm=SHA1&digits=6&period=30',
    description: 'Render as a QR code for the authenticator app to scan.',
  })
  otpauthUrl: string;
}

export class VendorSummaryDto {
  @ApiProperty({ enum: vendorStatusEnum.enumValues, example: 'pending' })
  status: VendorStatus;

  @ApiProperty({ nullable: true, example: 'EcoThreads Lagos' })
  businessName: string | null;

  @ApiProperty({
    nullable: true,
    example: 'ecothreads-lagos',
    description: 'Storefront slug, set at first approval.',
  })
  slug: string | null;

  @ApiProperty({
    nullable: true,
    example: 'The CAC certificate is unreadable. Upload a clearer scan.',
    description: 'Why the business was rejected or suspended.',
  })
  decisionReason: string | null;
}

export class MeDto {
  @ApiProperty({
    format: 'uuid',
    example: '0197c2a4-8f10-7a2b-b3c4-1d2e3f4a5b6c',
  })
  id: string;

  @ApiProperty({ example: 'aisha@ecothreads.ng' })
  email: string;

  @ApiProperty({ enum: roleEnum.enumValues, example: 'vendor' })
  role: Role;

  @ApiProperty({ example: 'Aisha Musa' })
  name: string;

  @ApiProperty({ nullable: true, example: '+2348031234567' })
  phone: string | null;

  @ApiProperty({
    nullable: true,
    description:
      'Presigned link to the profile picture; it expires, so refetch rather than store it.',
  })
  avatarUrl: string | null;

  @ApiProperty()
  twoFactorEnabled: boolean;

  @ApiProperty({
    description: 'This account type must use 2FA (vendors and admins).',
  })
  twoFactorRequired: boolean;

  @ApiProperty({
    type: VendorSummaryDto,
    nullable: true,
    description:
      'Verification status of the business. Null for non-vendors. Full profile: `GET /vendor/profile`.',
  })
  vendor: VendorSummaryDto | null;

  @ApiProperty({ example: '2026-11-05T09:30:00.000Z' })
  createdAt: Date;
}
