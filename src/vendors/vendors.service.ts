import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { v7 } from 'uuid';
import { recordAudit } from '../audit/audit.queries.js';
import type { AuthUser } from '../auth/auth-user.js';
import { findCategory } from '../categories/categories.queries.js';
import { type Page, toPage } from '../common/pagination.js';
import { SecretBox } from '../common/secret-box.js';
import { slugify, slugSuffix } from '../common/slug.js';
import { Database, type Tx } from '../database/database.js';
import {
  CERTIFICATION_NAMES,
  type Certification,
} from '../database/schema/index.js';
import { MailService } from '../mail/mail.service.js';
import {
  checkDocument,
  cleanFileName,
} from '../storage/documents.js';
import { checkImage, imageUrl, type UploadedImage } from '../storage/images.js';
import { ObjectStorage } from '../storage/object-storage.js';
import {
  findSuspension,
  findUserById,
} from '../users/users.queries.js';
import type {
  AdminVendorDetailDto,
  AdminVendorsQueryDto,
  AdminVendorSummaryDto,
  ApproveVendorDto,
  CertificationDto,
  UpdateVendorProfileDto,
  UploadDocumentDto,
  VendorDocumentDto,
  VendorProfileDto,
} from './dto/vendors.dto.js';
import {
  badgeFor,
  canEditIdentity,
  claimedCertifications,
  DECISIONS,
  missingForSubmission,
  type VendorDecision,
} from './onboarding.js';
import {
  countDocuments,
  deleteDocument,
  findVendor,
  insertDocument,
  listDocuments,
  listVendorsForAdmin,
  lockVendor,
  slugTaken,
  updateVendor,
  vendorDecisionHistory,
  type VendorDocumentRow,
  type VendorRow,
} from './vendors.queries.js';

/** Fields that identify the business; frozen while under review and after approval. */
const IDENTITY_FIELDS = [
  'businessName',
  'addressLine',
  'city',
  'state',
  'categoryId',
  'cacNumber',
  'directorIdType',
  'directorId',
] as const;

const MAX_DOCUMENTS = 20;

export const directorContext = (vendorId: string) => `director-id:${vendorId}`;

export const certificationDtos = (ids: readonly string[]): CertificationDto[] =>
  ids
    .filter((id): id is Certification => id in CERTIFICATION_NAMES)
    .map((id) => ({ id, name: CERTIFICATION_NAMES[id] }));

@Injectable()
export class VendorsService {
  private readonly logger = new Logger(VendorsService.name);

  constructor(
    private readonly database: Database,
    private readonly storage: ObjectStorage,
    private readonly box: SecretBox,
    private readonly mail: MailService,
  ) {}

  /* ---------------- vendor self-service ---------------- */

  async profile(vendorId: string): Promise<VendorProfileDto> {
    const vendor = await findVendor(this.database.db, vendorId);
    if (!vendor) throw new NotFoundException('Vendor profile not found');
    return this.toProfile(vendor);
  }

  async update(
    user: AuthUser,
    dto: UpdateVendorProfileDto,
  ): Promise<VendorProfileDto> {
    const fields = Object.entries(dto)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => k);
    if (fields.length === 0) throw new BadRequestException('No fields to update');
    if (dto.categoryId) {
      const category = await findCategory(this.database.db, dto.categoryId);
      if (!category?.isActive)
        throw new BadRequestException('categoryId is not an active category');
    }
    await this.database.transaction(async (tx) => {
      const vendor = await this.locked(tx, user.id);
      const identity = fields.filter((f) =>
        (IDENTITY_FIELDS as readonly string[]).includes(f),
      );
      if (identity.length > 0 && !canEditIdentity(vendor.status))
        throw new ConflictException(
          vendor.status === 'pending'
            ? 'Your application is under review; business details are locked until a decision'
            : 'Business details are locked after verification. Contact support to change them',
        );
      const { directorId, ...rest } = dto;
      await updateVendor(tx, user.id, {
        ...rest,
        ...(directorId !== undefined && {
          directorIdEncrypted: this.box.seal(directorId, directorContext(user.id)),
          directorIdLast4: directorId.slice(-4),
        }),
      });
      await recordAudit(tx, {
        action: 'vendor.profile_updated',
        actorId: user.id,
        resourceType: 'vendor',
        resourceId: user.id,
        // Field names only: never the NIN/BVN.
        metadata: { fields },
      });
    });
    return this.profile(user.id);
  }

  async setLogo(
    user: AuthUser,
    file: UploadedImage | undefined,
  ): Promise<VendorProfileDto> {
    const type = checkImage(file, 'logo', 'logo');
    const key = `vendors/${user.id}/logo-${v7()}.${type.ext}`;
    await this.storage.put(key, file!.buffer, type.mime);
    let previous: string | null;
    try {
      previous = await this.database.transaction(async (tx) => {
        const vendor = await this.locked(tx, user.id);
        await updateVendor(tx, user.id, { logoKey: key });
        await recordAudit(tx, {
          action: 'vendor.logo_updated',
          resourceType: 'vendor',
          resourceId: user.id,
        });
        return vendor.logoKey;
      });
    } catch (err) {
      await this.deleteObjects([key]);
      throw err;
    }
    if (previous) await this.deleteObjects([previous]);
    return this.profile(user.id);
  }

  async removeLogo(user: AuthUser): Promise<VendorProfileDto> {
    const previous = await this.database.transaction(async (tx) => {
      const vendor = await this.locked(tx, user.id);
      if (!vendor.logoKey) return null;
      await updateVendor(tx, user.id, { logoKey: null });
      await recordAudit(tx, {
        action: 'vendor.logo_removed',
        resourceType: 'vendor',
        resourceId: user.id,
      });
      return vendor.logoKey;
    });
    if (previous) await this.deleteObjects([previous]);
    return this.profile(user.id);
  }

  async addDocument(
    user: AuthUser,
    dto: UploadDocumentDto,
    file: UploadedImage | undefined,
  ): Promise<VendorProfileDto> {
    if (dto.kind !== 'sustainability_certificate' && dto.certification)
      throw new BadRequestException(
        'certification is only for kind sustainability_certificate',
      );
    const type = checkDocument(file, 'file');
    const key = `vendors/${user.id}/documents/${v7()}.${type.ext}`;
    await this.storage.put(key, file!.buffer, type.mime);
    try {
      await this.database.transaction(async (tx) => {
        const vendor = await this.locked(tx, user.id);
        this.assertDocumentsEditable(vendor);
        if ((await countDocuments(tx, user.id)) >= MAX_DOCUMENTS)
          throw new ConflictException(
            `At most ${MAX_DOCUMENTS} documents. Delete one first`,
          );
        const doc = await insertDocument(tx, {
          vendorId: user.id,
          kind: dto.kind,
          certification: dto.certification ?? null,
          storageKey: key,
          fileName: cleanFileName(file!.originalname),
          contentType: type.mime,
          sizeBytes: file!.buffer.length,
        });
        await recordAudit(tx, {
          action: 'vendor.document_added',
          resourceType: 'vendor',
          resourceId: user.id,
          metadata: { documentId: doc.id, kind: doc.kind },
        });
      });
    } catch (err) {
      await this.deleteObjects([key]);
      throw err;
    }
    return this.profile(user.id);
  }

  async removeDocument(
    user: AuthUser,
    documentId: string,
  ): Promise<VendorProfileDto> {
    const removed = await this.database.transaction(async (tx) => {
      const vendor = await this.locked(tx, user.id);
      this.assertDocumentsEditable(vendor);
      const doc = await deleteDocument(tx, user.id, documentId);
      if (!doc) throw new NotFoundException('Document not found');
      await recordAudit(tx, {
        action: 'vendor.document_removed',
        resourceType: 'vendor',
        resourceId: user.id,
        metadata: { documentId, kind: doc.kind },
      });
      return doc;
    });
    await this.deleteObjects([removed.storageKey]);
    return this.profile(user.id);
  }

  /** Sends the application to the admin queue (PRD V3: "Pending verification"). */
  async submit(user: AuthUser): Promise<VendorProfileDto> {
    await this.database.transaction(async (tx) => {
      const vendor = await this.locked(tx, user.id);
      if (vendor.status === 'pending')
        throw new ConflictException('Your application is already under review');
      if (!canEditIdentity(vendor.status))
        throw new ConflictException(
          `A ${vendor.status} business cannot be resubmitted`,
        );
      const documents = await listDocuments(tx, user.id);
      const missing = missingForSubmission({ ...vendor, documents });
      if (missing.length > 0)
        throw new BadRequestException({
          message: 'Complete your application before submitting',
          details: missing,
        });
      await updateVendor(tx, user.id, {
        status: 'pending',
        submittedAt: new Date(),
        submissionCount: vendor.submissionCount + 1,
      });
      await recordAudit(tx, {
        action: 'vendor.submitted',
        actorId: user.id,
        resourceType: 'vendor',
        resourceId: user.id,
        before: { status: vendor.status },
        after: { status: 'pending' },
      });
    });
    return this.profile(user.id);
  }

  /* ---------------- admin ---------------- */

  async adminList(
    query: AdminVendorsQueryDto,
  ): Promise<Page<AdminVendorSummaryDto>> {
    const { rows, total } = await this.database.readSnapshot((tx) =>
      listVendorsForAdmin(tx, query, query),
    );
    const now = Date.now();
    return toPage(
      rows.map((r) => ({
        ...r,
        waitingHours:
          r.status === 'pending' && r.submittedAt
            ? Math.round(((now - r.submittedAt.getTime()) / 3_600_000) * 10) /
              10
            : null,
      })),
      total,
      query,
    );
  }

  async adminDetail(id: string): Promise<AdminVendorDetailDto> {
    const db = this.database.db;
    const vendor = await findVendor(db, id);
    if (!vendor) throw new NotFoundException('Vendor not found');
    const [profile, owner, suspension, history, documents] = await Promise.all([
      this.toProfile(vendor),
      findUserById(db, id),
      findSuspension(db, id),
      vendorDecisionHistory(db, id),
      listDocuments(db, id),
    ]);
    return {
      ...profile,
      id,
      owner: {
        id,
        name: owner!.name,
        email: owner!.email,
        phone: owner!.phone,
        twoFactorEnabled: owner!.totpEnabledAt !== null,
        suspended: suspension !== undefined,
      },
      claimedCertifications: certificationDtos(claimedCertifications(documents)),
      foundingVendor: vendor.foundingVendor,
      submissionCount: vendor.submissionCount,
      history: history.map((h) => ({
        action: h.action,
        actorId: h.actorId,
        actorName: h.actorName,
        reason:
          typeof h.metadata.reason === 'string' ? h.metadata.reason : null,
        at: h.at,
      })),
    };
  }

  /**
   * Approves a pending application. The storefront slug is fixed on first
   * approval. Phase 2 creates the vendor's custodial wallet here (PRD V4).
   */
  async approve(
    admin: AuthUser,
    id: string,
    dto: ApproveVendorDto,
  ): Promise<AdminVendorDetailDto> {
    const vendor = await this.database.transaction(async (tx) => {
      const current = await this.decidable(tx, id, 'approve');
      const claimed = claimedCertifications(await listDocuments(tx, id));
      const accepted = dto.certifications ?? claimed;
      const unclaimed = accepted.filter((c) => !claimed.includes(c));
      if (unclaimed.length > 0)
        throw new BadRequestException(
          `No uploaded certificate for: ${unclaimed.join(', ')}`,
        );
      const updated = await updateVendor(tx, id, {
        status: 'approved',
        slug: current.slug ?? (await this.freeSlug(tx, current.businessName!)),
        verifiedCertifications: [...accepted].sort(),
        foundingVendor: dto.foundingVendor ?? current.foundingVendor,
        decisionReason: null,
        reviewedAt: new Date(),
        reviewedBy: admin.id,
        approvedAt: current.approvedAt ?? new Date(),
      });
      await recordAudit(tx, {
        action: 'vendor.approved',
        actorId: admin.id,
        resourceType: 'vendor',
        resourceId: id,
        metadata: { note: dto.note ?? null },
        before: { status: current.status },
        after: {
          status: 'approved',
          verifiedCertifications: updated.verifiedCertifications,
          foundingVendor: updated.foundingVendor,
        },
      });
      return updated;
    });
    void this.notify(vendor, 'approve', dto.note ?? null);
    return this.adminDetail(id);
  }

  /** reject | suspend | reinstate. */
  async decide(
    admin: AuthUser,
    id: string,
    decision: Exclude<VendorDecision, 'approve'>,
    reason: string | null,
  ): Promise<AdminVendorDetailDto> {
    const to = DECISIONS[decision].to;
    const vendor = await this.database.transaction(async (tx) => {
      const current = await this.decidable(tx, id, decision);
      const updated = await updateVendor(tx, id, {
        status: to,
        decisionReason: decision === 'reinstate' ? null : reason,
        reviewedAt: new Date(),
        reviewedBy: admin.id,
      });
      await recordAudit(tx, {
        action: `vendor.${to}`,
        actorId: admin.id,
        resourceType: 'vendor',
        resourceId: id,
        metadata: { reason },
        before: { status: current.status },
        after: { status: to },
      });
      return updated;
    });
    void this.notify(vendor, decision, reason);
    return this.adminDetail(id);
  }

  /* ---------------- helpers ---------------- */

  private async toProfile(vendor: VendorRow): Promise<VendorProfileDto> {
    const db = this.database.db;
    const [documents, category] = await Promise.all([
      listDocuments(db, vendor.userId),
      vendor.categoryId ? findCategory(db, vendor.categoryId) : undefined,
    ]);
    return {
      status: vendor.status,
      businessName: vendor.businessName,
      slug: vendor.slug,
      description: vendor.description,
      phone: vendor.phone,
      addressLine: vendor.addressLine,
      city: vendor.city,
      state: vendor.state,
      category: category
        ? { id: category.id, name: category.name, slug: category.slug }
        : null,
      cacNumber: vendor.cacNumber,
      directorIdType: vendor.directorIdType,
      directorIdLast4: vendor.directorIdLast4,
      logoUrl: await imageUrl(this.storage, vendor.logoKey),
      verifiedCertifications: certificationDtos(vendor.verifiedCertifications),
      badge:
        vendor.approvedAt !== null
          ? badgeFor(vendor.verifiedCertifications)
          : null,
      decisionReason: vendor.decisionReason,
      canEdit: canEditIdentity(vendor.status),
      missing: canEditIdentity(vendor.status)
        ? missingForSubmission({ ...vendor, documents })
        : [],
      documents: await Promise.all(documents.map((d) => this.toDocument(d))),
      submittedAt: vendor.submittedAt,
      reviewedAt: vendor.reviewedAt,
      approvedAt: vendor.approvedAt,
    };
  }

  private async toDocument(d: VendorDocumentRow): Promise<VendorDocumentDto> {
    return {
      id: d.id,
      kind: d.kind,
      certification: d.certification,
      fileName: d.fileName,
      contentType: d.contentType,
      sizeBytes: d.sizeBytes,
      url: await imageUrl(this.storage, d.storageKey),
      createdAt: d.createdAt,
    };
  }

  private async locked(tx: Tx, vendorId: string): Promise<VendorRow> {
    const vendor = await lockVendor(tx, vendorId);
    if (!vendor) throw new NotFoundException('Vendor profile not found');
    return vendor;
  }

  private assertDocumentsEditable(vendor: VendorRow) {
    if (!canEditIdentity(vendor.status))
      throw new ConflictException(
        vendor.status === 'pending'
          ? 'Your application is under review; documents are locked until a decision'
          : 'Documents are locked after verification. Contact support to change them',
      );
  }

  private async decidable(
    tx: Tx,
    id: string,
    decision: VendorDecision,
  ): Promise<VendorRow> {
    const vendor = await lockVendor(tx, id);
    if (!vendor) throw new NotFoundException('Vendor not found');
    const allowed: readonly string[] = DECISIONS[decision].from;
    if (!allowed.includes(vendor.status))
      throw new ConflictException(
        `Cannot ${decision} a vendor that is ${vendor.status}`,
      );
    return vendor;
  }

  /** Business name as a slug, with a random suffix if another store has it. */
  private async freeSlug(tx: Tx, businessName: string): Promise<string> {
    const base = slugify(businessName, 'store');
    if (!(await slugTaken(tx, base))) return base;
    return `${base}-${slugSuffix()}`;
  }

  /** After commit, never blocking the decision. */
  private async notify(
    vendor: VendorRow,
    decision: VendorDecision,
    reason: string | null,
  ) {
    try {
      const owner = await findUserById(this.database.db, vendor.userId);
      if (owner)
        await this.mail.sendVendorDecision(
          owner.email,
          vendor.businessName ?? 'Your store',
          decision,
          reason,
        );
    } catch (err) {
      this.logger.error(
        { err, vendorId: vendor.userId, decision },
        'Failed to send vendor decision email',
      );
    }
  }

  private async deleteObjects(keys: string[]) {
    try {
      await this.storage.delete(keys);
    } catch (err) {
      // An orphaned file costs storage, not correctness.
      this.logger.warn({ err, keys }, 'Could not delete stored file');
    }
  }
}
