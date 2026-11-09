import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { recordAudit } from '../audit/audit.queries.js';
import { deleteFamiliesForUser, setTotp } from '../auth/auth.queries.js';
import type { AuthUser } from '../auth/auth-user.js';
import { type Page, toPage } from '../common/pagination.js';
import { Database } from '../database/database.js';
import { isStaff, type Role } from '../database/schema/index.js';
import { imageUrl } from '../storage/images.js';
import { ObjectStorage } from '../storage/object-storage.js';
import { findVendorSummary } from '../vendors/vendors.queries.js';
import type {
  UserDetailDto,
  UserSummaryDto,
  UsersQueryDto,
} from './dto/users.dto.js';
import {
  deleteSuspension,
  findSuspension,
  findUserById,
  insertSuspension,
  listUsers,
  lockUser,
  userActivity,
  userName,
} from './users.queries.js';

/**
 * Admins manage customers and vendors; only super admins manage other staff
 * (PRD A7). Nobody acts on their own account here.
 */
function assertMayManage(actor: AuthUser, targetId: string, role: Role) {
  if (targetId === actor.id)
    throw new BadRequestException('You cannot do this to your own account');
  if (isStaff(role) && actor.role !== 'super_admin')
    throw new ForbiddenException('Only a super admin can manage admin accounts');
}

@Injectable()
export class UsersService {
  constructor(
    private readonly database: Database,
    private readonly storage: ObjectStorage,
  ) {}

  async list(query: UsersQueryDto): Promise<Page<UserSummaryDto>> {
    const { rows, total } = await this.database.readSnapshot((tx) =>
      listUsers(tx, query, query),
    );
    const result = await Promise.all(
      rows.map(async ({ avatarKey, ...row }) => ({
        ...row,
        avatarUrl: await imageUrl(this.storage, avatarKey),
      })),
    );
    return toPage(result, total, query);
  }

  /** Everything an admin may see about an account; never the password hash or 2FA secret. */
  async detail(id: string): Promise<UserDetailDto> {
    const db = this.database.db;
    const user = await findUserById(db, id);
    if (!user) throw new NotFoundException('User not found');
    const [suspension, activity, vendor] = await Promise.all([
      findSuspension(db, id),
      userActivity(db, id),
      user.role === 'vendor' ? findVendorSummary(db, id) : undefined,
    ]);
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      phone: user.phone,
      avatarUrl: await imageUrl(this.storage, user.avatarKey),
      emailVerified: user.emailVerifiedAt !== null,
      emailVerifiedAt: user.emailVerifiedAt,
      twoFactorEnabled: user.totpEnabledAt !== null,
      suspended: suspension !== undefined,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      lastLoginAt: activity.lastLoginAt,
      activeSessions: activity.activeSessions,
      vendor: vendor ?? null,
      suspension: suspension
        ? {
            reason: suspension.reason,
            suspendedBy: suspension.suspendedBy,
            suspendedByName: await userName(db, suspension.suspendedBy),
            suspendedAt: suspension.suspendedAt,
          }
        : null,
    };
  }

  /**
   * Signs the account out everywhere; login stays refused and a vendor's
   * products leave the storefront until restored (PRD A6). Idempotent.
   */
  async suspend(
    actor: AuthUser,
    id: string,
    reason: string,
  ): Promise<UserDetailDto> {
    await this.database.transaction(async (tx) => {
      const user = await lockUser(tx, id, 'update');
      if (!user) throw new NotFoundException('User not found');
      assertMayManage(actor, id, user.role);
      if (await findSuspension(tx, id)) return;
      await insertSuspension(tx, { userId: id, reason, suspendedBy: actor.id });
      await deleteFamiliesForUser(tx, id);
      await recordAudit(tx, {
        action: 'user.suspended',
        actorId: actor.id,
        resourceType: 'user',
        resourceId: id,
        metadata: { reason },
        before: { suspended: false },
        after: { suspended: true },
      });
    });
    return this.detail(id);
  }

  /** Lets the account sign in again. Idempotent. */
  async restore(actor: AuthUser, id: string): Promise<UserDetailDto> {
    await this.database.transaction(async (tx) => {
      const user = await lockUser(tx, id, 'update');
      if (!user) throw new NotFoundException('User not found');
      assertMayManage(actor, id, user.role);
      const removed = await deleteSuspension(tx, id);
      if (!removed) return;
      await recordAudit(tx, {
        action: 'user.restored',
        actorId: actor.id,
        resourceType: 'user',
        resourceId: id,
        before: { suspended: true, reason: removed.reason },
        after: { suspended: false },
      });
    });
    return this.detail(id);
  }

  /**
   * For a user who lost their authenticator: turns 2FA off and signs them out.
   * Vendors and admins must set it up again at their next sign-in.
   */
  async resetTwoFactor(
    actor: AuthUser,
    id: string,
    reason: string,
  ): Promise<UserDetailDto> {
    await this.database.transaction(async (tx) => {
      const user = await lockUser(tx, id, 'update');
      if (!user) throw new NotFoundException('User not found');
      assertMayManage(actor, id, user.role);
      if (!user.totpEnabledAt && !user.totpSecret)
        throw new ConflictException('Two-factor sign-in is not on');
      await setTotp(tx, id, {
        totpSecret: null,
        totpEnabledAt: null,
        totpLastStep: null,
      });
      await deleteFamiliesForUser(tx, id);
      await recordAudit(tx, {
        action: 'user.mfa_reset',
        actorId: actor.id,
        resourceType: 'user',
        resourceId: id,
        metadata: { reason },
      });
    });
    return this.detail(id);
  }
}
