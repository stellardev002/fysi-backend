import {
  Body,
  Controller,
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
import { CurrentUser } from '../auth/decorators.js';
import { Roles } from '../authorization/roles.decorator.js';
import { ApiRoute } from '../common/api-docs.js';
import type { Page } from '../common/pagination.js';
import { STAFF_ROLES } from '../database/schema/index.js';
import {
  AdminVendorDetailDto,
  AdminVendorsQueryDto,
  AdminVendorSummaryDto,
  ApproveVendorDto,
  VendorNoteDto,
  VendorReasonDto,
} from './dto/vendors.dto.js';
import { PROFILE_EXAMPLE } from './vendor.controller.js';
import { VendorsService } from './vendors.service.js';

const ID = '0197c2a4-8f10-7a2b-b3c4-1d2e3f4a5b6c';

const DETAIL_EXAMPLE = {
  ...PROFILE_EXAMPLE,
  id: ID,
  status: 'pending',
  canEdit: false,
  missing: [],
  submittedAt: '2026-11-07T10:00:00.000Z',
  owner: {
    id: ID,
    name: 'Aisha Musa',
    email: 'aisha@ecothreads.ng',
    phone: '+2348031234567',
    twoFactorEnabled: true,
    suspended: false,
  },
  claimedCertifications: [{ id: 'gots', name: 'GOTS' }],
  foundingVendor: false,
  submissionCount: 1,
  history: [],
};

const ERRORS = [HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN];
const NOT_FOUND = { status: HttpStatus.NOT_FOUND, message: 'Vendor not found' };
const WRONG_STATUS = (decision: string, status: string) => ({
  status: HttpStatus.CONFLICT,
  description: `The vendor is not in a status this decision applies to.`,
  message: `Cannot ${decision} a vendor that is ${status}`,
});

@ApiTags('Admin Vendors')
@ApiBearerAuth()
@Roles(...STAFF_ROLES)
@Controller('admin/vendors')
export class AdminVendorsController {
  constructor(private readonly vendors: VendorsService) {}

  @ApiRoute({
    summary: 'Vendor verification queue',
    path: '/api/v1/admin/vendors',
    description:
      '`status=pending` is the verification queue (PRD A1), oldest submission first, with `waitingHours` against the 72-hour target. Without `status`, every vendor, most recently changed first. `q` matches business name, owner email or CAC number.',
    message: 'Vendors retrieved',
    model: AdminVendorSummaryDto,
    paginated: true,
    example: {
      result: [
        {
          id: ID,
          status: 'pending',
          businessName: 'EcoThreads Lagos',
          email: 'aisha@ecothreads.ng',
          ownerName: 'Aisha Musa',
          city: 'Lekki',
          state: 'Lagos',
          categoryName: 'Clothing',
          submissionCount: 1,
          submittedAt: '2026-11-07T10:00:00.000Z',
          waitingHours: 30.5,
          reviewedAt: null,
          createdAt: '2026-11-07T09:00:00.000Z',
        },
      ],
      paginationMeta: {
        nextPage: false,
        previousPage: false,
        currentPage: 1,
        totalPage: 1,
        totalCount: 1,
        pageCount: 1,
      },
    },
    errors: [HttpStatus.BAD_REQUEST, ...ERRORS],
  })
  @Get()
  list(@Query() query: AdminVendorsQueryDto): Promise<Page<AdminVendorSummaryDto>> {
    return this.vendors.adminList(query);
  }

  @ApiRoute({
    summary: 'Review one vendor',
    path: '/api/v1/admin/vendors/{id}',
    description:
      'The full application: business details, owner account, documents with download links (they expire), the certifications the certificates claim, and the decision history. The director NIN/BVN shows its last 4 digits only.',
    message: 'Vendor retrieved',
    model: AdminVendorDetailDto,
    example: DETAIL_EXAMPLE,
    errors: [...ERRORS, NOT_FOUND],
  })
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<AdminVendorDetailDto> {
    return this.vendors.adminDetail(id);
  }

  @HttpCode(HttpStatus.OK)
  @ApiRoute({
    summary: 'Approve a vendor',
    path: '/api/v1/admin/vendors/{id}/approve',
    description: `Approves a \`pending\` application. The vendor can list products straight away and gets an email.

- \`certifications\`: labels to accept from those claimed (default: all). Accepted labels earn the **Certified** badge; none means **Fysi Reviewed**.
- \`foundingVendor\`: 0% commission for 3 months.
- The storefront slug is fixed from the business name on first approval.
- Phase 2: the vendor's custodial wallet is created here (PRD V4).`,
    message: 'Vendor approved',
    model: AdminVendorDetailDto,
    example: {
      ...DETAIL_EXAMPLE,
      status: 'approved',
      slug: 'ecothreads-lagos',
      badge: 'certified',
      verifiedCertifications: [{ id: 'gots', name: 'GOTS' }],
    },
    errors: [
      {
        status: HttpStatus.BAD_REQUEST,
        description: 'A label in `certifications` has no uploaded certificate.',
        message: 'No uploaded certificate for: fsc',
      },
      ...ERRORS,
      NOT_FOUND,
      WRONG_STATUS('approve', 'draft'),
    ],
  })
  @Post(':id/approve')
  approve(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveVendorDto,
  ): Promise<AdminVendorDetailDto> {
    return this.vendors.approve(admin, id, dto);
  }

  @HttpCode(HttpStatus.OK)
  @ApiRoute({
    summary: 'Reject a vendor',
    path: '/api/v1/admin/vendors/{id}/reject',
    description:
      'Rejects a `pending` application with a reason the vendor sees (dashboard and email). The vendor can fix it and resubmit.',
    message: 'Vendor rejected',
    model: AdminVendorDetailDto,
    example: {
      ...DETAIL_EXAMPLE,
      status: 'rejected',
      canEdit: true,
      decisionReason: 'The CAC certificate is unreadable. Upload a clearer scan.',
    },
    errors: [HttpStatus.BAD_REQUEST, ...ERRORS, NOT_FOUND, WRONG_STATUS('reject', 'approved')],
  })
  @Post(':id/reject')
  reject(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VendorReasonDto,
  ): Promise<AdminVendorDetailDto> {
    return this.vendors.decide(admin, id, 'reject', dto.reason);
  }

  @HttpCode(HttpStatus.OK)
  @ApiRoute({
    summary: 'Suspend a vendor',
    path: '/api/v1/admin/vendors/{id}/suspend',
    description:
      'Suspends an `approved` store: its products leave the storefront and it cannot list more. The vendor can still sign in and sees the reason. To lock the account itself, use `POST /admin/users/{id}/suspension`.',
    message: 'Vendor suspended',
    model: AdminVendorDetailDto,
    example: {
      ...DETAIL_EXAMPLE,
      status: 'suspended',
      decisionReason: 'Listing products without the claimed certification.',
    },
    errors: [HttpStatus.BAD_REQUEST, ...ERRORS, NOT_FOUND, WRONG_STATUS('suspend', 'pending')],
  })
  @Post(':id/suspend')
  suspend(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VendorReasonDto,
  ): Promise<AdminVendorDetailDto> {
    return this.vendors.decide(admin, id, 'suspend', dto.reason);
  }

  @HttpCode(HttpStatus.OK)
  @ApiRoute({
    summary: 'Reinstate a suspended vendor',
    path: '/api/v1/admin/vendors/{id}/reinstate',
    description: 'Puts a `suspended` store back to `approved`; its active products return.',
    message: 'Vendor reinstated',
    model: AdminVendorDetailDto,
    example: { ...DETAIL_EXAMPLE, status: 'approved' },
    errors: [...ERRORS, NOT_FOUND, WRONG_STATUS('reinstate', 'approved')],
  })
  @Post(':id/reinstate')
  reinstate(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VendorNoteDto,
  ): Promise<AdminVendorDetailDto> {
    return this.vendors.decide(admin, id, 'reinstate', dto.note ?? null);
  }
}
