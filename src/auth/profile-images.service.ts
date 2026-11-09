import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { v7 } from 'uuid';
import { recordAudit } from '../audit/audit.queries.js';
import { Database, type Tx } from '../database/database.js';
import { checkImage, type UploadedImage } from '../storage/images.js';
import { ObjectStorage } from '../storage/object-storage.js';
import { lockUser, updateUser } from '../users/users.queries.js';
import type { AuthUser } from './auth-user.js';
import { AuthService } from './auth.service.js';
import type { MeDto } from './dto/auth.dto.js';

/** The profile picture every account has. Vendor logos live in the vendors module. */
export type ProfileImage = 'avatar';

const LABEL: Record<ProfileImage, string> = {
  avatar: 'profile picture',
};

/** Profile picture uploads. The object is stored first, then the row points at it. */
@Injectable()
export class ProfileImagesService {
  private readonly logger = new Logger(ProfileImagesService.name);

  constructor(
    private readonly database: Database,
    private readonly storage: ObjectStorage,
    private readonly auth: AuthService,
  ) {}

  async set(
    user: AuthUser,
    kind: ProfileImage,
    file: UploadedImage | undefined,
  ): Promise<MeDto> {
    const type = checkImage(file, kind, LABEL[kind]);
    const key = `users/${user.id}/${kind}-${v7()}.${type.ext}`;
    await this.storage.put(key, file!.buffer, type.mime);
    let previous: string | null;
    try {
      previous = await this.database.transaction((tx) =>
        this.swap(tx, user, kind, key),
      );
    } catch (err) {
      await this.deleteObject(key);
      throw err;
    }
    if (previous) await this.deleteObject(previous);
    return this.auth.me(user.id);
  }

  /** Removing a missing image changes nothing. */
  async remove(user: AuthUser, kind: ProfileImage): Promise<MeDto> {
    const previous = await this.database.transaction((tx) =>
      this.swap(tx, user, kind, null),
    );
    if (previous) await this.deleteObject(previous);
    return this.auth.me(user.id);
  }

  /** Points the account at `key` and returns the key it replaced. */
  private async swap(
    tx: Tx,
    user: AuthUser,
    kind: ProfileImage,
    key: string | null,
  ): Promise<string | null> {
    // Serialises concurrent uploads, so a replaced object is always deleted.
    const row = await lockUser(tx, user.id, 'update');
    if (!row) throw new UnauthorizedException();
    const previous = row.avatarKey;
    if (previous === key) return null;
    await updateUser(tx, user.id, { avatarKey: key });
    await recordAudit(tx, {
      action: key ? `auth.${kind}_updated` : `auth.${kind}_removed`,
      actorId: user.id,
    });
    return previous;
  }

  private async deleteObject(key: string): Promise<void> {
    try {
      await this.storage.delete([key]);
    } catch (err) {
      // An orphaned image costs storage, not correctness.
      this.logger.warn({ err, key }, 'Could not delete stored image');
    }
  }
}
