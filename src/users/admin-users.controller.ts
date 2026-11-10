import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth-user.js';
import { AuthService } from '../auth/auth.service.js';
import { CurrentUser } from '../auth/decorators.js';
import { Roles } from '../authorization/roles.decorator.js';
import { STAFF_ROLES } from '../database/schema/index.js';
import { ApiRoute } from '../common/api-docs.js';
import type { Page } from '../common/pagination.js';
import {
  CreateAdminDto,
  CreatedAdminDto,
  ResetTwoFactorDto,
  SuspendUserDto,
  UserDetailDto,
  UserSummaryDto,
  UsersQueryDto,
  DeleteUserDto,
} from './dto/users.dto.js';
import { UsersService } from './users.service.js';

const USER_EXAMPLE = {
  id: '0197c2a4-8f10-7a2b-b3c4-1d2e3f4a5b6c',
  email: 'aisha@ecothreads.ng',
  name: 'Aisha Musa',
  role: 'vendor',
  avatarUrl: null,
  emailVerified: true,
  suspended: false,
  createdAt: '2026-11-05T09:30:00.000Z',
};

const ADMIN_ERRORS = [HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN];
const NOT_FOUND = {
  status: HttpStatus.NOT_FOUND,
  message: 'User not found',
  description: 'No user with this id.',
};

@ApiTags('Admin Users')
@ApiBearerAuth()
@Roles(...STAFF_ROLES)
@Controller('admin/users')
export class AdminUsersController {
  constructor(
    private readonly users: UsersService,
    private readonly auth: AuthService,
  ) {}

  @ApiRoute({
    summary: 'List accounts',
    path: '/api/v1/admin/users',
    description:
      'Customers, vendors and admins, newest first. `q` matches the name or email; `role`, `suspended` and `emailVerified` narrow the list.',
    message: 'Users retrieved',
    model: UserSummaryDto,
    paginated: true,
    example: {
      result: [USER_EXAMPLE],
      paginationMeta: {
        nextPage: false,
        previousPage: false,
        currentPage: 1,
        totalPage: 1,
        totalCount: 1,
        pageCount: 1,
      },
    },
    errors: [HttpStatus.BAD_REQUEST, ...ADMIN_ERRORS],
  })
  @Get()
  list(@Query() query: UsersQueryDto): Promise<Page<UserSummaryDto>> {
    return this.users.list(query);
  }

  @ApiRoute({
    summary: 'Get one account',
    path: '/api/v1/admin/users/{id}',
    description:
      'Everything about the account: phone, 2FA state, when the email was verified, the last sign-in, how many devices are signed in, the verification status of a vendor business and, while suspended, who suspended it, when and why.',
    message: 'User retrieved',
    model: UserDetailDto,
    example: {
      ...USER_EXAMPLE,
      phone: '+2348031234567',
      twoFactorEnabled: true,
      emailVerifiedAt: '2026-11-05T09:32:00.000Z',
      updatedAt: '2026-11-05T10:00:00.000Z',
      lastLoginAt: '2026-11-06T08:15:00.000Z',
      activeSessions: 1,
      vendor: {
        status: 'approved',
        businessName: 'EcoThreads Lagos',
        slug: 'ecothreads-lagos',
        decisionReason: null,
      },
      suspension: null,
    },
    errors: [...ADMIN_ERRORS, NOT_FOUND],
  })
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<UserDetailDto> {
    return this.users.detail(id);
  }

  @Roles('super_admin')
  @ApiRoute({
    summary: 'Create an admin (super admins)',
    path: '/api/v1/admin/users',
    description:
      'Super admins only. Creates an admin with a verified email and no usable password, then emails a password setup code. The new admin finishes at `POST /api/v1/auth/reset-password` with that code, then must turn on 2FA. No password ever passes through the creator.',
    message: 'Admin created. A password setup code was emailed',
    status: HttpStatus.CREATED,
    model: CreatedAdminDto,
    example: {
      id: '0197c2a4-9a11-7c2b-b3c4-1d2e3f4a5b6c',
      email: 'samuel@fysi.ng',
      name: 'Samuel Okon',
      role: 'admin',
      createdAt: '2026-11-05T09:30:00.000Z',
      otpExpiresInSeconds: 600,
    },
    errors: [
      HttpStatus.BAD_REQUEST,
      ...ADMIN_ERRORS,
      {
        status: HttpStatus.CONFLICT,
        description: 'An account already uses this email.',
      },
    ],
  })
  @Post()
  createAdmin(
    @CurrentUser() actor: AuthUser,
    @Body() dto: CreateAdminDto,
  ): Promise<CreatedAdminDto> {
    return this.auth.createAdmin(actor, dto);
  }

  @ApiRoute({
    summary: 'Suspend an account',
    path: '/api/v1/admin/users/{id}/suspension',
    description:
      'Signs the account out of every session at once and refuses sign-in until restored. A suspended vendor\'s products leave the storefront. Suspending an already-suspended account changes nothing. You cannot suspend yourself; only super admins can suspend admins.',
    message: 'Account suspended',
    status: HttpStatus.CREATED,
    model: UserDetailDto,
    example: {
      ...USER_EXAMPLE,
      suspended: true,
      suspension: {
        reason: 'Selling items that are not eco-friendly',
        suspendedBy: '0197c2a4-9a11-7c2b-b3c4-1d2e3f4a5b6c',
        suspendedAt: '2026-11-05T10:00:00.000Z',
      },
    },
    errors: [
      {
        status: HttpStatus.BAD_REQUEST,
        description: 'Missing reason, or the admin tried to suspend themself.',
        message: 'You cannot do this to your own account',
      },
      ...ADMIN_ERRORS,
      NOT_FOUND,
    ],
  })
  @Post(':id/suspension')
  suspend(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SuspendUserDto,
  ): Promise<UserDetailDto> {
    return this.users.suspend(actor, id, dto.reason);
  }

  @ApiRoute({
    summary: 'Restore a suspended account',
    path: '/api/v1/admin/users/{id}/suspension',
    description:
      'Lets the account sign in again. Sessions ended by the suspension stay ended. Restoring an account that is not suspended changes nothing.',
    message: 'Account restored',
    model: UserDetailDto,
    example: { ...USER_EXAMPLE, suspension: null },
    errors: [...ADMIN_ERRORS, NOT_FOUND],
  })
  @Delete(':id/suspension')
  restore(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<UserDetailDto> {
    return this.users.restore(actor, id);
  }

  @ApiRoute({
    summary: 'Reset two-factor sign-in',
    path: '/api/v1/admin/users/{id}/2fa/reset',
    description:
      'For a user who lost their authenticator: turns 2FA off and signs them out everywhere. Vendors and admins must set it up again at their next sign-in. Confirm the person\'s identity first; the reason goes to the audit log. Only super admins can reset an admin.',
    message: 'Two-factor sign-in reset',
    model: UserDetailDto,
    example: { ...USER_EXAMPLE, twoFactorEnabled: false, suspension: null },
    errors: [
      HttpStatus.BAD_REQUEST,
      ...ADMIN_ERRORS,
      NOT_FOUND,
      {
        status: HttpStatus.CONFLICT,
        message: 'Two-factor sign-in is not on',
        description: 'Nothing to reset.',
      },
    ],
  })
  @HttpCode(HttpStatus.OK)
  @Post(':id/2fa/reset')
  resetTwoFactor(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResetTwoFactorDto,
  ): Promise<UserDetailDto> {
    return this.users.resetTwoFactor(actor, id, dto.reason);
  }

  @ApiRoute({
    summary: 'Delete a customer account',
    path: '/api/v1/admin/users/{id}',
    description: `For a customer who asked to be deleted, or for abuse. Cannot be undone.

- Erased: name, email (free to sign up again), phone, photo, password, 2FA, sessions, cart, wishlist, saved addresses, inbox, newsletter entry. Unpaid checkouts are cancelled and their stock returned.
- Kept for the books: orders, payments and reviews, shown as "Deleted customer"; the audit log records who did it and why.
- Refused while an order is partly paid or has payment in escrow, or while the customer's Fysi wallet holds funds (\`error.details\` says which).
- Customers only: vendors are suspended instead.`,
    message: 'Account deleted',
    model: UserDetailDto,
    errors: [
      {
        status: HttpStatus.BAD_REQUEST,
        message: 'Vendor accounts are suspended, not deleted: their orders and payouts need the store',
        description: 'Missing reason, not a customer, or your own account.',
      },
      ...ADMIN_ERRORS,
      NOT_FOUND,
      {
        status: HttpStatus.CONFLICT,
        message: 'This account has orders still in progress',
        details: ['1 order(s) with payment in escrow: wait for delivery, release or refund'],
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    ],
  })
  @Delete(':id')
  remove(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeleteUserDto,
  ): Promise<UserDetailDto> {
    return this.users.deleteCustomer(actor, id, dto.reason);
  }
}
