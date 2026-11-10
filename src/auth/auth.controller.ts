import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Put,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrors, ApiRoute } from '../common/api-docs.js';
import { RateLimit } from '../rate-limit/rate-limit.decorator.js';
import { MAX_IMAGE_BYTES, type UploadedImage } from '../storage/images.js';
import type { AuthUser } from './auth-user.js';
import { AuthService } from './auth.service.js';
import { AllowWithoutMfa, CurrentUser, Public } from './decorators.js';
import { MFA_SETUP_REQUIRED } from './jwt-auth.guard.js';
import { ProfileImagesService } from './profile-images.service.js';
import {
  AuthTokensDto,
  ChangePasswordDto,
  DisableTwoFactorDto,
  EmailDto,
  LoginDto,
  LoginResultDto,
  MeDto,
  OtpIssuedDto,
  RefreshDto,
  RegisterDto,
  RegisterResultDto,
  ResetPasswordDto,
  TwoFactorCodeDto,
  TwoFactorLoginDto,
  TwoFactorSetupDto,
  UpdateProfileDto,
  VerifyEmailDto,
} from './dto/auth.dto.js';

// 5 attempts burst, then one every 12 seconds, per IP.
const CREDENTIAL_BUCKET = { capacity: 5, refillPerSec: 1 / 12 };

const TOKENS_EXAMPLE = {
  accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIwMTk3...',
  refreshToken: 'k3JxV0b8mZ2nQ5uY7wA1cD4eF6gH9iL0oP3rS5tU8vX',
  tokenType: 'Bearer',
  expiresIn: 900,
  role: 'customer',
  mfa: false,
  twoFactorSetupRequired: false,
};

const MFA_TOKENS_EXAMPLE = {
  ...TOKENS_EXAMPLE,
  role: 'vendor',
  mfa: true,
  twoFactorSetupRequired: false,
};

const MFA_SETUP_FORBIDDEN = {
  status: HttpStatus.FORBIDDEN,
  description:
    'Only when MFA_REQUIRED_ROLES lists the caller’s role and 2FA is not on yet (off by default).',
  message: MFA_SETUP_REQUIRED,
};

const OTP_ISSUED_EXAMPLE = { otpExpiresInSeconds: 600, resendAfterSeconds: 60 };

const ME_EXAMPLE = {
  id: '0197c2a4-8f10-7a2b-b3c4-1d2e3f4a5b6c',
  email: 'aisha@ecothreads.ng',
  role: 'vendor',
  name: 'Aisha Musa',
  phone: '+2348031234567',
  avatarUrl: null,
  twoFactorEnabled: true,
  twoFactorRequired: false,
  vendor: {
    status: 'pending',
    businessName: 'EcoThreads Lagos',
    slug: null,
    decisionReason: null,
  },
  createdAt: '2026-11-05T09:30:00.000Z',
};

const IMAGE_ERRORS = (part: string, what: string) => [
  {
    status: HttpStatus.BAD_REQUEST,
    message: `Send the image as a multipart file part named "${part}"`,
  },
  HttpStatus.UNAUTHORIZED,
  { status: HttpStatus.PAYLOAD_TOO_LARGE, description: 'Over 5 MB.' },
  {
    status: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    message: `The ${what} must be a JPEG, PNG or WebP image`,
  },
  {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description: 'Image storage is not configured or is unreachable.',
    message: 'Image storage is unavailable',
  },
];

const imageBody = (part: string) =>
  ApiBody({
    schema: {
      type: 'object',
      required: [part],
      properties: { [part]: { type: 'string', format: 'binary' } },
    },
  });

const imageUpload = (part: string) =>
  FileInterceptor(part, {
    limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 5 },
  });

const CODE_REJECTED = {
  status: HttpStatus.BAD_REQUEST,
  description:
    'Body failed validation, or the code is wrong, expired or already used. All three look the same on purpose.',
  message: 'Invalid or expired code',
};

const COOLDOWN = {
  status: HttpStatus.TOO_MANY_REQUESTS,
  description:
    'A code was issued less than `resendAfterSeconds` ago, or the per-IP limit was hit. `Retry-After` says how long to wait.',
  message: 'Wait before requesting another code',
  retryAfterSeconds: 42,
};

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly images: ProfileImagesService,
  ) {}

  @Public()
  @RateLimit(CREDENTIAL_BUCKET)
  @ApiRoute({
    summary: 'Create a customer or vendor account',
    path: '/api/v1/auth/register',
    description: `Creates an account and emails a 6-digit verification code. No tokens are issued until the email is verified: call \`POST /auth/verify-email\` next.

- \`accountType\`: \`customer\` (default) or \`vendor\`. Admins cannot sign up.
- Guests sign up at checkout as customers; after verifying, merge the browser cart with \`POST /cart/merge\`.
- Vendors start with a business profile in \`draft\`; they turn on 2FA, complete \`/vendor/profile\`, upload documents and submit for verification.
- Signing up again with an email held by an **unverified** account replaces that account. A **verified** account is never replaced and returns 409.
- Rate limited: 5 requests burst, then one every 12 seconds, per IP.`,
    message: 'Account created. Check your email for the verification code',
    status: HttpStatus.CREATED,
    model: RegisterResultDto,
    example: {
      email: 'grace@example.com',
      accountType: 'customer',
      otpExpiresInSeconds: 600,
      resendAfterSeconds: 60,
    },
    errors: [
      {
        status: HttpStatus.BAD_REQUEST,
        description: 'Validation failed.',
        message: 'Validation failed',
        details: ['password must be longer than or equal to 8 characters'],
      },
      {
        status: HttpStatus.CONFLICT,
        description: 'A verified account already uses this email.',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    ],
  })
  @ApiBody({
    type: RegisterDto,
    examples: {
      customer: {
        summary: 'Customer (at checkout)',
        value: {
          name: 'Grace Ajayi',
          email: 'grace@example.com',
          password: 'correct-horse-battery',
        },
      },
      vendor: {
        summary: 'Vendor',
        value: {
          accountType: 'vendor',
          name: 'Aisha Musa',
          email: 'aisha@ecothreads.ng',
          password: 'correct-horse-battery',
          phone: '+2348031234567',
          businessName: 'EcoThreads Lagos',
        },
      },
    },
  })
  @Post('register')
  register(@Body() dto: RegisterDto): Promise<RegisterResultDto> {
    return this.auth.register(dto);
  }

  @Public()
  @RateLimit(CREDENTIAL_BUCKET)
  @HttpCode(HttpStatus.OK)
  @ApiRoute({
    summary: 'Verify email and sign in',
    path: '/api/v1/auth/verify-email',
    description: `Confirms the 6-digit code emailed at signup and returns the first token pair, so the user is signed in straight away. Vendors get \`twoFactorSetupRequired: true\`: set up 2FA next.

- The code expires after \`otpExpiresInSeconds\` (default 10 minutes) and works once.
- Five wrong attempts burn the code; request a new one with \`POST /auth/resend-otp\`.
- Rate limited: 5 requests burst, then one every 12 seconds, per IP.`,
    message: 'Email verified',
    model: AuthTokensDto,
    example: TOKENS_EXAMPLE,
    errors: [CODE_REJECTED, HttpStatus.TOO_MANY_REQUESTS],
  })
  @Post('verify-email')
  verifyEmail(@Body() dto: VerifyEmailDto): Promise<AuthTokensDto> {
    return this.auth.verifyEmail(dto);
  }

  @Public()
  @RateLimit({ capacity: 3, refillPerSec: 1 / 60 })
  @HttpCode(HttpStatus.OK)
  @ApiRoute({
    summary: 'Resend the verification code',
    path: '/api/v1/auth/resend-otp',
    description: `Issues a new verification code for an account that has not verified yet, replacing the old one.

- Always answers 200 with the same shape, whether or not the email exists or is already verified, so it does not reveal accounts.
- One code per \`resendAfterSeconds\` (60). Asking sooner returns 429 with \`Retry-After\`.
- Rate limited: 3 requests burst, then one per minute, per IP.`,
    message: 'If the account is awaiting verification, a new code was sent',
    model: OtpIssuedDto,
    example: OTP_ISSUED_EXAMPLE,
    errors: [HttpStatus.BAD_REQUEST, COOLDOWN],
  })
  @Post('resend-otp')
  resendOtp(@Body() dto: EmailDto): Promise<OtpIssuedDto> {
    return this.auth.resendOtp(dto);
  }

  @Public()
  @RateLimit({ capacity: 3, refillPerSec: 1 / 60 })
  @HttpCode(HttpStatus.OK)
  @ApiRoute({
    summary: 'Request a password reset code',
    path: '/api/v1/auth/forgot-password',
    description: `Emails a 6-digit reset code to a **verified** account. Finish with \`POST /auth/reset-password\`.

- Always answers 200 with the same shape, whether or not the account exists.
- A reset code cannot be used as a signup code, or the reverse.
- One code per \`resendAfterSeconds\` (60); asking sooner returns 429 with \`Retry-After\`.
- Rate limited: 3 requests burst, then one per minute, per IP.`,
    message: 'If the account exists, a reset code was sent',
    model: OtpIssuedDto,
    example: OTP_ISSUED_EXAMPLE,
    errors: [HttpStatus.BAD_REQUEST, COOLDOWN],
  })
  @Post('forgot-password')
  forgotPassword(@Body() dto: EmailDto): Promise<OtpIssuedDto> {
    return this.auth.forgotPassword(dto);
  }

  @Public()
  @RateLimit(CREDENTIAL_BUCKET)
  @HttpCode(HttpStatus.OK)
  @ApiRoute({
    summary: 'Reset the password with a code',
    path: '/api/v1/auth/reset-password',
    description: `Sets a new password using the code from \`POST /auth/forgot-password\`. New admins also use this, with the code from their welcome email.

- **Signs out every session** of the account, including access tokens already issued. The user signs in again with the new password.
- Two-factor sign-in stays on: the authenticator code is still needed. A user who lost their authenticator asks an admin to reset 2FA.
- Five wrong attempts burn the code.
- Rate limited: 5 requests burst, then one every 12 seconds, per IP.`,
    message: 'Password reset. Sign in with the new password',
    errors: [CODE_REJECTED, HttpStatus.TOO_MANY_REQUESTS],
  })
  @Post('reset-password')
  resetPassword(@Body() dto: ResetPasswordDto): Promise<void> {
    return this.auth.resetPassword(dto);
  }

  @Public()
  @RateLimit(CREDENTIAL_BUCKET)
  @HttpCode(HttpStatus.OK)
  @ApiRoute({
    summary: 'Sign in',
    path: '/api/v1/auth/login',
    description: `Checks email and password. Every account type signs in here; \`role\` tells the client which area to open.

- **Without 2FA**: \`mfaRequired: false\` plus the token pair.
- **With 2FA**: \`mfaRequired: true\` and an \`mfaToken\` (5 minutes), no tokens yet. Send it with the authenticator code to \`POST /auth/login/2fa\`.
- A vendor or admin who has not set up 2FA yet gets tokens with \`twoFactorSetupRequired: true\`; until 2FA is on, only \`/auth/me\`, \`/auth/2fa/*\` and sign-out work.
- Suspended accounts get 403 \`Account suspended\`; unverified emails get 403 \`Email not verified\`.
- Wrong email and wrong password return the same 401.
- Rate limited: 5 requests burst, then one every 12 seconds, per IP.`,
    message: 'Login successful',
    model: LoginResultDto,
    example: {
      mfaRequired: true,
      mfaToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIwMTk3...',
      mfaTokenExpiresIn: 300,
    },
    errors: [
      HttpStatus.BAD_REQUEST,
      {
        status: HttpStatus.UNAUTHORIZED,
        description: 'Email or password is wrong.',
        message: 'Invalid credentials',
      },
      {
        status: HttpStatus.FORBIDDEN,
        description:
          'The password is right but the email is not verified yet (`Email not verified`), or an admin suspended the account (`Account suspended`).',
        message: 'Email not verified',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    ],
  })
  @Post('login')
  login(@Body() dto: LoginDto): Promise<LoginResultDto> {
    return this.auth.login(dto);
  }

  @Public()
  @RateLimit(CREDENTIAL_BUCKET)
  @HttpCode(HttpStatus.OK)
  @ApiRoute({
    summary: 'Finish sign-in with the authenticator code',
    path: '/api/v1/auth/login/2fa',
    description: `Second step for accounts with 2FA. Returns the token pair with \`mfa: true\`.

- Each code works once. An \`mfaToken\` dies after 5 minutes or when the password changes.
- Rate limited: 5 requests burst, then one every 12 seconds, per IP.`,
    message: 'Login successful',
    model: AuthTokensDto,
    example: MFA_TOKENS_EXAMPLE,
    errors: [
      {
        status: HttpStatus.BAD_REQUEST,
        description: 'Wrong, expired or already-used code.',
        message: 'Invalid or expired code',
      },
      {
        status: HttpStatus.UNAUTHORIZED,
        description:
          'The mfaToken is invalid or expired, or the password changed since.',
        message: 'Sign-in expired. Enter your email and password again',
      },
      {
        status: HttpStatus.FORBIDDEN,
        message: 'Account suspended',
        description: 'An admin suspended the account.',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    ],
  })
  @Post('login/2fa')
  loginTwoFactor(@Body() dto: TwoFactorLoginDto): Promise<AuthTokensDto> {
    return this.auth.loginTwoFactor(dto);
  }

  @ApiBearerAuth()
  @AllowWithoutMfa()
  @RateLimit(CREDENTIAL_BUCKET)
  @HttpCode(HttpStatus.OK)
  @ApiRoute({
    summary: 'Start two-factor setup',
    path: '/api/v1/auth/2fa/setup',
    description: `Returns a new authenticator secret and an \`otpauth://\` URL to show as a QR code. Calling it again replaces the secret. Sign-in does not change until \`POST /auth/2fa/enable\` confirms a code.

Required for vendors and admins (PRD); optional for customers.`,
    message: 'Scan the QR code, then confirm a code',
    model: TwoFactorSetupDto,
    example: {
      secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
      otpauthUrl:
        'otpauth://totp/Fysi%3Aaisha%40ecothreads.ng?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Fysi&algorithm=SHA1&digits=6&period=30',
    },
    errors: [
      HttpStatus.UNAUTHORIZED,
      {
        status: HttpStatus.CONFLICT,
        message: 'Two-factor sign-in is already on',
        description: '2FA is already enabled.',
      },
    ],
  })
  @Post('2fa/setup')
  setupTwoFactor(@CurrentUser() user: AuthUser): Promise<TwoFactorSetupDto> {
    return this.auth.setupTwoFactor(user);
  }

  @ApiBearerAuth()
  @AllowWithoutMfa()
  @RateLimit(CREDENTIAL_BUCKET)
  @HttpCode(HttpStatus.OK)
  @ApiRoute({
    summary: 'Turn two-factor sign-in on',
    path: '/api/v1/auth/2fa/enable',
    description: `Confirms a code from the authenticator app and turns 2FA on.

- **Signs out every session**, this one included, and returns a **new token pair** (\`mfa: true\`). Replace the stored tokens with these.
- From now on \`POST /auth/login\` asks for a code.`,
    message: 'Two-factor sign-in is on',
    model: AuthTokensDto,
    example: MFA_TOKENS_EXAMPLE,
    errors: [
      {
        status: HttpStatus.BAD_REQUEST,
        description:
          'Wrong code, or `POST /auth/2fa/setup` was not called first.',
        message: 'Invalid or expired code',
      },
      HttpStatus.UNAUTHORIZED,
      {
        status: HttpStatus.CONFLICT,
        message: 'Two-factor sign-in is already on',
        description: '2FA is already enabled.',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    ],
  })
  @Post('2fa/enable')
  enableTwoFactor(
    @CurrentUser() user: AuthUser,
    @Body() dto: TwoFactorCodeDto,
  ): Promise<AuthTokensDto> {
    return this.auth.enableTwoFactor(user, dto.code);
  }

  @ApiBearerAuth()
  @RateLimit(CREDENTIAL_BUCKET)
  @HttpCode(HttpStatus.OK)
  @ApiRoute({
    summary: 'Turn two-factor sign-in off (customers)',
    path: '/api/v1/auth/2fa/disable',
    description:
      'Needs the password and a current code. Signs out every other session. Vendors and admins cannot turn 2FA off (403); if they lose the authenticator, an admin resets it.',
    message: 'Two-factor sign-in is off',
    errors: [
      {
        status: HttpStatus.BAD_REQUEST,
        message: 'Password or code is incorrect',
        description: 'Wrong password or code.',
      },
      HttpStatus.UNAUTHORIZED,
      {
        status: HttpStatus.FORBIDDEN,
        message: 'Two-factor sign-in is required for your account type',
        description: 'Vendors and admins must keep 2FA.',
      },
      {
        status: HttpStatus.CONFLICT,
        message: 'Two-factor sign-in is not on',
        description: '2FA is not enabled.',
      },
    ],
  })
  @Post('2fa/disable')
  disableTwoFactor(
    @CurrentUser() user: AuthUser,
    @Body() dto: DisableTwoFactorDto,
  ): Promise<void> {
    return this.auth.disableTwoFactor(user, dto);
  }

  @Public()
  @RateLimit({ capacity: 10, refillPerSec: 1 / 6 })
  @HttpCode(HttpStatus.OK)
  @ApiRoute({
    summary: 'Refresh the access token',
    path: '/api/v1/auth/refresh',
    description: `Trades a refresh token for a new access token and a **new refresh token**. Each refresh token works once.

- Replaying a token that was already used is treated as theft: the whole session (every token descended from that login) is revoked and the call returns 401.
- Call this when the access token expires (\`expiresIn\` seconds after issue) or a protected route returns 401.
- Rate limited: 10 requests burst, then one every 6 seconds, per IP.`,
    message: 'Token refreshed',
    model: AuthTokensDto,
    example: TOKENS_EXAMPLE,
    errors: [
      HttpStatus.BAD_REQUEST,
      {
        status: HttpStatus.UNAUTHORIZED,
        description:
          'The refresh token is unknown, expired, already used or revoked.',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    ],
  })
  @Post('refresh')
  refresh(@Body() dto: RefreshDto): Promise<AuthTokensDto> {
    return this.auth.refresh(dto.refreshToken);
  }

  @Public()
  @RateLimit({ capacity: 10, refillPerSec: 1 / 6 })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Sign out this session',
    description: `Revokes the session that owns the refresh token. Its access tokens stop working immediately. Other sessions are untouched; use \`POST /auth/logout-all\` for those.

Always returns 204 with no body, even for an unknown or already-revoked token.

Rate limited: 10 requests burst, then one every 6 seconds, per IP.`,
  })
  @ApiResponse({
    status: HttpStatus.NO_CONTENT,
    description: 'Signed out. No body.',
  })
  @ApiErrors(
    '/api/v1/auth/logout',
    HttpStatus.BAD_REQUEST,
    HttpStatus.TOO_MANY_REQUESTS,
  )
  @Post('logout')
  logout(@Body() dto: RefreshDto): Promise<void> {
    return this.auth.logout(dto.refreshToken);
  }

  @ApiBearerAuth()
  @AllowWithoutMfa()
  @HttpCode(HttpStatus.OK)
  @ApiRoute({
    summary: 'Sign out of all sessions',
    path: '/api/v1/auth/logout-all',
    description:
      'Revokes every session of the signed-in user on every device, including the one making this call. All access tokens stop working immediately.',
    message: 'Signed out of all sessions',
    errors: [HttpStatus.UNAUTHORIZED],
  })
  @Post('logout-all')
  logoutAll(@CurrentUser() user: AuthUser): Promise<void> {
    return this.auth.logoutAll(user.id);
  }

  @ApiBearerAuth()
  @RateLimit(CREDENTIAL_BUCKET)
  @HttpCode(HttpStatus.OK)
  @ApiRoute({
    summary: 'Change the password',
    path: '/api/v1/auth/change-password',
    description: `Changes the password of the signed-in user after checking the current one.

- **Signs out every other session.** The session making this call stays valid.
- A wrong current password returns 400, not 401, so clients do not mistake it for an expired token.
- Rate limited: 5 requests burst, then one every 12 seconds.`,
    message: 'Password changed. Other sessions were signed out',
    errors: [
      {
        status: HttpStatus.BAD_REQUEST,
        description:
          'Body failed validation, or the current password is wrong.',
        message: 'Current password is incorrect',
      },
      HttpStatus.UNAUTHORIZED,
      HttpStatus.TOO_MANY_REQUESTS,
    ],
  })
  @Post('change-password')
  changePassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
  ): Promise<void> {
    return this.auth.changePassword(user, dto);
  }

  @ApiBearerAuth()
  @AllowWithoutMfa()
  @ApiRoute({
    summary: 'Get the signed-in user',
    path: '/api/v1/auth/me',
    description:
      'Returns the account of the access token owner, its 2FA state and, for vendors, the verification status of the business (`vendor`). Works before 2FA is set up, so the client can route there.',
    message: 'Profile retrieved',
    model: MeDto,
    example: ME_EXAMPLE,
    errors: [HttpStatus.UNAUTHORIZED],
  })
  @Get('me')
  me(@CurrentUser() user: AuthUser): Promise<MeDto> {
    return this.auth.me(user.id);
  }

  @ApiBearerAuth()
  @ApiRoute({
    summary: 'Update the signed-in user',
    path: '/api/v1/auth/me',
    description: `Partial update: send only the fields to change. Returns the updated account.

- \`phone\`: international format; \`""\` or \`null\` clears it.
- The sign-in email cannot be changed here. Vendors edit their business at \`PATCH /vendor/profile\`.
- An empty body is rejected.`,
    message: 'Profile updated',
    model: MeDto,
    example: ME_EXAMPLE,
    errors: [
      {
        status: HttpStatus.BAD_REQUEST,
        description: 'Empty body, unknown field or invalid value.',
        message: 'No fields to update',
      },
      HttpStatus.UNAUTHORIZED,
      MFA_SETUP_FORBIDDEN,
    ],
  })
  @ApiBody({
    type: UpdateProfileDto,
    examples: {
      phone: {
        summary: 'Add a phone number',
        value: { phone: '+2348031234567' },
      },
    },
  })
  @Patch('me')
  updateMe(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateProfileDto,
  ): Promise<MeDto> {
    return this.auth.updateProfile(user, dto);
  }

  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @imageBody('avatar')
  @UseInterceptors(imageUpload('avatar'))
  @ApiRoute({
    summary: 'Upload or replace the profile picture',
    path: '/api/v1/auth/me/avatar',
    description:
      'Every account. One `multipart/form-data` part named `avatar`: JPEG, PNG or WebP, up to 5 MB, checked by its bytes. Replaces any previous picture. Returns the updated account with `avatarUrl`.',
    message: 'Profile picture updated',
    model: MeDto,
    example: ME_EXAMPLE,
    errors: IMAGE_ERRORS('avatar', 'profile picture'),
  })
  @Put('me/avatar')
  setAvatar(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: UploadedImage | undefined,
  ): Promise<MeDto> {
    return this.images.set(user, 'avatar', file);
  }

  @ApiBearerAuth()
  @ApiRoute({
    summary: 'Remove the profile picture',
    path: '/api/v1/auth/me/avatar',
    description: 'Removing a missing picture changes nothing.',
    message: 'Profile picture removed',
    model: MeDto,
    example: ME_EXAMPLE,
    errors: [HttpStatus.UNAUTHORIZED],
  })
  @Delete('me/avatar')
  removeAvatar(@CurrentUser() user: AuthUser): Promise<MeDto> {
    return this.images.remove(user, 'avatar');
  }
}
