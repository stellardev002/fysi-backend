import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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
  ApiTags,
} from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser } from '../auth/decorators.js';
import { Roles } from '../authorization/roles.decorator.js';
import { ApiRoute } from '../common/api-docs.js';
import { CERTIFICATIONS, vendorDocumentKindEnum } from '../database/schema/index.js';
import { MAX_DOCUMENT_BYTES } from '../storage/documents.js';
import { MAX_IMAGE_BYTES, type UploadedImage } from '../storage/images.js';
import {
  UpdateVendorProfileDto,
  UploadDocumentDto,
  VendorProfileDto,
} from './dto/vendors.dto.js';
import { VendorsService } from './vendors.service.js';

export const PROFILE_EXAMPLE = {
  status: 'draft',
  businessName: 'EcoThreads Lagos',
  slug: null,
  description: 'Handmade clothing from organic cotton and recycled fabric.',
  phone: '+2348031234567',
  addressLine: '12 Admiralty Way',
  city: 'Lekki',
  state: 'Lagos',
  category: {
    id: '0197c2a4-5b1e-7d3a-9c10-6f2e8b4a1d55',
    name: 'Clothing',
    slug: 'clothing',
  },
  cacNumber: 'RC1234567',
  directorIdType: 'nin',
  directorIdLast4: '8901',
  logoUrl: null,
  verifiedCertifications: [],
  badge: null,
  decisionReason: null,
  canEdit: true,
  missing: ['document:sustainability_certificate_or_evidence'],
  documents: [
    {
      id: '0197c2a5-0000-7000-8000-000000000001',
      kind: 'cac_certificate',
      certification: null,
      fileName: 'cac-certificate.pdf',
      contentType: 'application/pdf',
      sizeBytes: 284113,
      url: 'https://<bucket>.t3.storageapi.dev/vendors/…?X-Amz-Signature=…',
      createdAt: '2026-11-07T09:30:00.000Z',
    },
  ],
  submittedAt: null,
  reviewedAt: null,
  approvedAt: null,
};

const VENDOR_ERRORS = [
  HttpStatus.UNAUTHORIZED,
  {
    status: HttpStatus.FORBIDDEN,
    description: 'Not a vendor account.',
  },
];

const LOCKED = {
  status: HttpStatus.CONFLICT,
  description:
    'Business details and documents are locked while pending and after approval.',
  message:
    'Your application is under review; business details are locked until a decision',
};

@ApiTags('Vendor Onboarding')
@ApiBearerAuth()
@Roles('vendor')
@Controller('vendor')
export class VendorController {
  constructor(private readonly vendors: VendorsService) {}

  @ApiRoute({
    summary: 'Get my business profile',
    path: '/api/v1/vendor/profile',
    description:
      'The onboarding wizard state (PRD V2–V3): business details, documents with download links, verification `status`, `decisionReason` after a rejection, and `missing` — what still blocks submission.',
    message: 'Vendor profile retrieved',
    model: VendorProfileDto,
    example: PROFILE_EXAMPLE,
    errors: VENDOR_ERRORS,
  })
  @Get('profile')
  profile(@CurrentUser() user: AuthUser): Promise<VendorProfileDto> {
    return this.vendors.profile(user.id);
  }

  @ApiRoute({
    summary: 'Update my business profile',
    path: '/api/v1/vendor/profile',
    description: `Partial update; send only what changes. Returns the whole profile.

- Business identity (name, address, state, category, CAC number, director NIN/BVN) can change only in \`draft\` or after a rejection.
- \`description\` and \`phone\` can change any time.
- The director's NIN/BVN is stored encrypted; responses show the last 4 digits only.`,
    message: 'Vendor profile updated',
    model: VendorProfileDto,
    example: PROFILE_EXAMPLE,
    errors: [
      {
        status: HttpStatus.BAD_REQUEST,
        description: 'Validation failed, empty body or unknown category.',
        message: 'Validation failed',
        details: ['cacNumber must look like RC1234567, BN1234567 or IT1234567'],
      },
      ...VENDOR_ERRORS,
      LOCKED,
    ],
  })
  @ApiBody({
    type: UpdateVendorProfileDto,
    examples: {
      wizard: {
        summary: 'Onboarding step: business details',
        value: {
          businessName: 'EcoThreads Lagos',
          addressLine: '12 Admiralty Way',
          city: 'Lekki',
          state: 'Lagos',
          phone: '+2348031234567',
          categoryId: '0197c2a4-5b1e-7d3a-9c10-6f2e8b4a1d55',
          cacNumber: 'RC1234567',
          directorIdType: 'nin',
          directorId: '12345678901',
        },
      },
    },
  })
  @Patch('profile')
  update(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateVendorProfileDto,
  ): Promise<VendorProfileDto> {
    return this.vendors.update(user, dto);
  }

  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['logo'],
      properties: { logo: { type: 'string', format: 'binary' } },
    },
  })
  @UseInterceptors(
    FileInterceptor('logo', {
      limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 5 },
    }),
  )
  @ApiRoute({
    summary: 'Upload or replace the store logo',
    path: '/api/v1/vendor/profile/logo',
    description:
      'One `multipart/form-data` part named `logo`: JPEG, PNG or WebP, up to 5 MB, checked by its bytes. Square works best.',
    message: 'Logo updated',
    model: VendorProfileDto,
    example: PROFILE_EXAMPLE,
    errors: [
      HttpStatus.BAD_REQUEST,
      ...VENDOR_ERRORS,
      HttpStatus.PAYLOAD_TOO_LARGE,
      {
        status: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        message: 'The logo must be a JPEG, PNG or WebP image',
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    ],
  })
  @Put('profile/logo')
  setLogo(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: UploadedImage | undefined,
  ): Promise<VendorProfileDto> {
    return this.vendors.setLogo(user, file);
  }

  @ApiRoute({
    summary: 'Remove the store logo',
    path: '/api/v1/vendor/profile/logo',
    message: 'Logo removed',
    model: VendorProfileDto,
    example: PROFILE_EXAMPLE,
    errors: VENDOR_ERRORS,
  })
  @Delete('profile/logo')
  removeLogo(@CurrentUser() user: AuthUser): Promise<VendorProfileDto> {
    return this.vendors.removeLogo(user);
  }

  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'kind'],
      properties: {
        file: { type: 'string', format: 'binary' },
        kind: { type: 'string', enum: vendorDocumentKindEnum.enumValues },
        certification: { type: 'string', enum: [...CERTIFICATIONS] },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1, fields: 5 },
    }),
  )
  @ApiRoute({
    summary: 'Upload a verification document',
    path: '/api/v1/vendor/documents',
    description: `\`multipart/form-data\` with a \`file\` part (PDF, JPEG, PNG or WebP, up to 10 MB) and a \`kind\` field.

- Needed to submit: \`cac_certificate\`, plus either a \`sustainability_certificate\` (with \`certification\`, e.g. \`gots\`) for the **Certified** badge, or \`sustainability_evidence\` (materials, sourcing, photos) for **Fysi Reviewed**.
- Optional: \`director_id\`, \`proof_of_address\`.
- Documents are private: only the vendor and admins get download links.
- Up to 20 documents; locked while under review and after approval.`,
    message: 'Document uploaded',
    status: HttpStatus.CREATED,
    model: VendorProfileDto,
    example: PROFILE_EXAMPLE,
    errors: [
      {
        status: HttpStatus.BAD_REQUEST,
        description:
          'No file part, unknown kind, or `certification` missing/misplaced.',
        message: 'Send the document as a multipart file part named "file"',
      },
      ...VENDOR_ERRORS,
      LOCKED,
      HttpStatus.PAYLOAD_TOO_LARGE,
      {
        status: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        message: 'The document must be a PDF, JPEG, PNG or WebP file',
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    ],
  })
  @Post('documents')
  addDocument(
    @CurrentUser() user: AuthUser,
    @Body() dto: UploadDocumentDto,
    @UploadedFile() file: UploadedImage | undefined,
  ): Promise<VendorProfileDto> {
    return this.vendors.addDocument(user, dto, file);
  }

  @ApiRoute({
    summary: 'Delete a verification document',
    path: '/api/v1/vendor/documents/{id}',
    description: 'Only in `draft` or after a rejection.',
    message: 'Document deleted',
    model: VendorProfileDto,
    example: PROFILE_EXAMPLE,
    errors: [
      ...VENDOR_ERRORS,
      { status: HttpStatus.NOT_FOUND, message: 'Document not found' },
      LOCKED,
    ],
  })
  @Delete('documents/:id')
  removeDocument(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<VendorProfileDto> {
    return this.vendors.removeDocument(user, id);
  }

  @HttpCode(HttpStatus.OK)
  @ApiRoute({
    summary: 'Submit for verification',
    path: '/api/v1/vendor/submit',
    description: `Sends the application to the admin queue; \`status\` becomes \`pending\` ("Pending verification", PRD V3). Business details and documents lock until a decision.

- Allowed from \`draft\` and \`rejected\` (a resubmission after fixing the reasons).
- An incomplete application returns 400 with what is missing in \`error.details\` (same names as \`missing\`).
- The vendor gets an email when an admin decides.`,
    message: 'Submitted for verification',
    model: VendorProfileDto,
    example: {
      ...PROFILE_EXAMPLE,
      status: 'pending',
      canEdit: false,
      missing: [],
      submittedAt: '2026-11-07T10:00:00.000Z',
    },
    errors: [
      {
        status: HttpStatus.BAD_REQUEST,
        description: 'Something required is missing.',
        message: 'Complete your application before submitting',
        details: ['cacNumber', 'document:cac_certificate'],
      },
      ...VENDOR_ERRORS,
      {
        status: HttpStatus.CONFLICT,
        description: 'Already pending, approved or suspended.',
        message: 'Your application is already under review',
      },
    ],
  })
  @Post('submit')
  submit(@CurrentUser() user: AuthUser): Promise<VendorProfileDto> {
    return this.vendors.submit(user);
  }
}
