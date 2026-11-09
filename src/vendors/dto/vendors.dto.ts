import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  normalisePhone,
  PHONE,
  trim,
  trimOrNull,
} from '../../auth/dto/auth.dto.js';
import { PaginationQueryDto } from '../../common/pagination.js';
import {
  BADGES,
  type Badge,
  CERTIFICATIONS,
  type Certification,
  directorIdTypeEnum,
  type DirectorIdType,
  vendorDocumentKindEnum,
  type VendorDocumentKind,
  vendorStatusEnum,
  type VendorStatus,
} from '../../database/schema/index.js';

export const NIGERIAN_STATES = [
  'Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue',
  'Borno', 'Cross River', 'Delta', 'Ebonyi', 'Edo', 'Ekiti', 'Enugu', 'FCT',
  'Gombe', 'Imo', 'Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi',
  'Kwara', 'Lagos', 'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo',
  'Plateau', 'Rivers', 'Sokoto', 'Taraba', 'Yobe', 'Zamfara',
] as const;

/** RC (company), BN (business name) or IT (incorporated trustees) plus digits. */
const CAC_NUMBER = /^(RC|BN|IT)\d{5,8}$/;

export class CategoryRefDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Clothing' }) name: string;
  @ApiProperty({ example: 'clothing' }) slug: string;
}

export class CertificationDto {
  @ApiProperty({ enum: CERTIFICATIONS, example: 'gots' })
  id: Certification;

  @ApiProperty({ example: 'GOTS' })
  name: string;
}

export class VendorDocumentDto {
  @ApiProperty({ format: 'uuid' }) id: string;

  @ApiProperty({ enum: vendorDocumentKindEnum.enumValues })
  kind: VendorDocumentKind;

  @ApiProperty({
    enum: CERTIFICATIONS,
    nullable: true,
    description: 'For `sustainability_certificate`: the label it proves.',
  })
  certification: string | null;

  @ApiProperty({ example: 'cac-certificate.pdf' }) fileName: string;
  @ApiProperty({ example: 'application/pdf' }) contentType: string;
  @ApiProperty({ example: 284113 }) sizeBytes: number;

  @ApiProperty({
    nullable: true,
    description:
      'Presigned download link; it expires, so refetch rather than store it. Null if storage is unavailable.',
  })
  url: string | null;

  @ApiProperty() createdAt: Date;
}

export class VendorProfileDto {
  @ApiProperty({ enum: vendorStatusEnum.enumValues, example: 'draft' })
  status: VendorStatus;

  @ApiProperty({ nullable: true, example: 'EcoThreads Lagos' })
  businessName: string | null;

  @ApiProperty({
    nullable: true,
    example: 'ecothreads-lagos',
    description: 'Storefront slug (`/vendors/{slug}`), set at first approval.',
  })
  slug: string | null;

  @ApiProperty({
    nullable: true,
    example: 'Handmade clothing from organic cotton and recycled fabric.',
  })
  description: string | null;

  @ApiProperty({ nullable: true, example: '+2348031234567' })
  phone: string | null;

  @ApiProperty({ nullable: true, example: '12 Admiralty Way' })
  addressLine: string | null;

  @ApiProperty({ nullable: true, example: 'Lekki' })
  city: string | null;

  @ApiProperty({ nullable: true, enum: NIGERIAN_STATES, example: 'Lagos' })
  state: string | null;

  @ApiProperty({ type: CategoryRefDto, nullable: true })
  category: CategoryRefDto | null;

  @ApiProperty({ nullable: true, example: 'RC1234567' })
  cacNumber: string | null;

  @ApiProperty({ nullable: true, enum: directorIdTypeEnum.enumValues })
  directorIdType: DirectorIdType | null;

  @ApiProperty({
    nullable: true,
    example: '4321',
    description: 'Last 4 digits only. The full number is never returned.',
  })
  directorIdLast4: string | null;

  @ApiProperty({ nullable: true }) logoUrl: string | null;

  @ApiProperty({
    type: [CertificationDto],
    description: 'Labels accepted at approval. Products may only claim these.',
  })
  verifiedCertifications: CertificationDto[];

  @ApiProperty({
    enum: BADGES,
    nullable: true,
    description:
      '`certified` with an accepted label, `fysi_reviewed` without. Null until approved.',
  })
  badge: Badge | null;

  @ApiProperty({
    nullable: true,
    description: 'Why the business was rejected or suspended.',
  })
  decisionReason: string | null;

  @ApiProperty({
    description:
      'Business identity and documents can change (in `draft` or after a rejection). Description, phone and logo can always change.',
  })
  canEdit: boolean;

  @ApiProperty({
    example: ['cacNumber', 'document:cac_certificate'],
    description:
      'What still blocks `POST /vendor/submit`. Empty when ready. Fields by name; documents as `document:<kind>`.',
  })
  missing: string[];

  @ApiProperty({ type: [VendorDocumentDto] })
  documents: VendorDocumentDto[];

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  submittedAt: Date | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  reviewedAt: Date | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  approvedAt: Date | null;
}

export class UpdateVendorProfileDto {
  @ApiPropertyOptional({ example: 'EcoThreads Lagos', maxLength: 120 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  businessName?: string;

  @ApiPropertyOptional({
    example: 'Handmade clothing from organic cotton and recycled fabric.',
    maxLength: 2000,
    nullable: true,
    description: 'Shown on the storefront. Editable any time.',
  })
  @IsOptional()
  @Transform(trimOrNull)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiPropertyOptional({
    example: '+2348031234567',
    description: 'Business phone. Editable any time.',
  })
  @IsOptional()
  @Transform(normalisePhone)
  @Matches(PHONE, {
    message: 'phone must be in international format, e.g. +2348031234567',
  })
  phone?: string;

  @ApiPropertyOptional({ example: '12 Admiralty Way', maxLength: 200 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  addressLine?: string;

  @ApiPropertyOptional({ example: 'Lekki', maxLength: 80 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  city?: string;

  @ApiPropertyOptional({ enum: NIGERIAN_STATES, example: 'Lagos' })
  @IsOptional()
  @IsIn(NIGERIAN_STATES)
  state?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Main category, from `GET /categories`.',
  })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({
    example: 'RC1234567',
    description:
      'CAC registration number: RC, BN or IT followed by digits. Spaces are ignored.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/\s/g, '').toUpperCase() : value,
  )
  @Matches(CAC_NUMBER, {
    message: 'cacNumber must look like RC1234567, BN1234567 or IT1234567',
  })
  cacNumber?: string;

  @ApiPropertyOptional({ enum: directorIdTypeEnum.enumValues })
  @ValidateIf((o: UpdateVendorProfileDto) => o.directorId !== undefined)
  @IsIn(directorIdTypeEnum.enumValues, {
    message: 'directorIdType must be nin or bvn (send it with directorId)',
  })
  directorIdType?: DirectorIdType;

  @ApiPropertyOptional({
    example: '12345678901',
    description:
      "Director's NIN or BVN: 11 digits. Stored encrypted; only the last 4 digits are ever shown. Send with `directorIdType`.",
  })
  @ValidateIf((o: UpdateVendorProfileDto) => o.directorIdType !== undefined)
  @Matches(/^\d{11}$/, { message: 'directorId must be 11 digits' })
  directorId?: string;
}

export class UploadDocumentDto {
  @ApiProperty({
    enum: vendorDocumentKindEnum.enumValues,
    description:
      '`cac_certificate` is required. Then either `sustainability_certificate` (with `certification`) for the Certified badge, or `sustainability_evidence` (materials, sourcing, photos) for Fysi Reviewed.',
  })
  @IsIn(vendorDocumentKindEnum.enumValues)
  kind: VendorDocumentKind;

  @ApiPropertyOptional({
    enum: CERTIFICATIONS,
    description: 'Required with `sustainability_certificate`; not allowed otherwise.',
  })
  @ValidateIf(
    (o: UploadDocumentDto) =>
      o.kind === 'sustainability_certificate' || o.certification !== undefined,
  )
  @IsIn(CERTIFICATIONS, {
    message: `certification must be one of: ${CERTIFICATIONS.join(', ')} (and only with kind sustainability_certificate)`,
  })
  certification?: Certification;
}

/* ---------- admin ---------- */

export class AdminVendorsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: vendorStatusEnum.enumValues,
    description: '`pending` is the verification queue, oldest first.',
  })
  @IsOptional()
  @IsIn(vendorStatusEnum.enumValues)
  status?: VendorStatus;

  @ApiPropertyOptional({
    description: 'Matches business name, owner email or CAC number.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}

export class AdminVendorSummaryDto {
  @ApiProperty({ format: 'uuid', description: 'The vendor account id.' })
  id: string;

  @ApiProperty({ enum: vendorStatusEnum.enumValues })
  status: VendorStatus;

  @ApiProperty({ nullable: true }) businessName: string | null;
  @ApiProperty() email: string;
  @ApiProperty() ownerName: string;
  @ApiProperty({ nullable: true }) city: string | null;
  @ApiProperty({ nullable: true }) state: string | null;
  @ApiProperty({ nullable: true }) categoryName: string | null;

  @ApiProperty({ description: 'Times submitted, resubmissions included.' })
  submissionCount: number;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  submittedAt: Date | null;

  @ApiProperty({
    nullable: true,
    example: 30.5,
    description:
      'Hours since submission while pending (PRD target: decided within 72).',
  })
  waitingHours: number | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  reviewedAt: Date | null;

  @ApiProperty() createdAt: Date;
}

export class VendorOwnerDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() name: string;
  @ApiProperty() email: string;
  @ApiProperty({ nullable: true }) phone: string | null;
  @ApiProperty() twoFactorEnabled: boolean;
  @ApiProperty({ description: 'Account suspended (A6).' }) suspended: boolean;
}

export class VendorDecisionEntryDto {
  @ApiProperty({ example: 'vendor.rejected' }) action: string;
  @ApiProperty({ nullable: true, format: 'uuid' }) actorId: string | null;
  @ApiProperty({ nullable: true }) actorName: string | null;
  @ApiProperty({ nullable: true }) reason: string | null;
  @ApiProperty() at: Date;
}

export class AdminVendorDetailDto extends VendorProfileDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ type: VendorOwnerDto }) owner: VendorOwnerDto;

  @ApiProperty({
    type: [CertificationDto],
    description:
      'Labels the uploaded certificates claim; approving accepts these unless `certifications` narrows them.',
  })
  claimedCertifications: CertificationDto[];

  @ApiProperty() foundingVendor: boolean;
  @ApiProperty() submissionCount: number;

  @ApiProperty({ type: [VendorDecisionEntryDto] })
  history: VendorDecisionEntryDto[];
}

export class ApproveVendorDto {
  @ApiPropertyOptional({
    enum: CERTIFICATIONS,
    isArray: true,
    description:
      'Labels to accept, from those the certificates claim. Default: all claimed. `[]` accepts none (Fysi Reviewed).',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(CERTIFICATIONS.length)
  @IsIn(CERTIFICATIONS, { each: true })
  certifications?: Certification[];

  @ApiPropertyOptional({
    default: false,
    description:
      'Founding vendor: 0% commission for the first 3 months (PRD decision).',
  })
  @IsOptional()
  @IsBoolean()
  foundingVendor?: boolean;

  @ApiPropertyOptional({ maxLength: 500, description: 'Sent to the vendor.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class VendorReasonDto {
  @ApiProperty({
    example: 'The CAC certificate is unreadable. Upload a clearer scan.',
    minLength: 3,
    maxLength: 1000,
    description: 'Shown to the vendor and kept in the audit log.',
  })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason: string;
}

export class VendorNoteDto {
  @ApiPropertyOptional({ maxLength: 500, description: 'Sent to the vendor.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}

/* ---------- public ---------- */

export class PublicVendorDto {
  @ApiProperty({ example: 'ecothreads-lagos' }) slug: string;
  @ApiProperty({ example: 'EcoThreads Lagos' }) businessName: string;
  @ApiProperty({ nullable: true }) description: string | null;
  @ApiProperty({ nullable: true }) logoUrl: string | null;
  @ApiProperty({ nullable: true, example: 'Lekki' }) city: string | null;
  @ApiProperty({ nullable: true, example: 'Lagos' }) state: string | null;
  @ApiProperty({ type: CategoryRefDto, nullable: true })
  category: CategoryRefDto | null;

  @ApiProperty({ enum: BADGES, description: 'Verified-vendor badge type.' })
  badge: Badge;

  @ApiProperty({ type: [CertificationDto] })
  certifications: CertificationDto[];

  @ApiProperty({ example: 14, description: 'Products on sale right now.' })
  productCount: number;

  @ApiProperty({ description: 'When the vendor was first verified.' })
  verifiedSince: Date;
}
