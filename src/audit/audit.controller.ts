import { Controller, Get, HttpStatus, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Roles } from '../authorization/roles.decorator.js';
import { ApiRoute } from '../common/api-docs.js';
import { type Page, PaginationQueryDto, toPage } from '../common/pagination.js';
import { Database } from '../database/database.js';
import { STAFF_ROLES } from '../database/schema/index.js';
import { AuditLogDto } from './dto/audit.dto.js';
import { listAudit } from './audit.queries.js';
import { IsCalendarDate } from '../common/calendar-date.js';

class AuditQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  action?: string;

  @IsOptional()
  @IsUUID()
  actorId?: string;

  @ApiPropertyOptional({
    example: 'user',
    description:
      'Kind of record the event touched: `user`, `vendor`, `product`, `category`.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  resourceType?: string;

  @ApiPropertyOptional({
    description: 'Id of the record the event touched.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  resourceId?: string;

  @ApiPropertyOptional({
    example: 'auth',
    description: 'First word of the action, e.g. `auth`, `user`, `admin`.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  category?: string;

  @ApiPropertyOptional({
    example: '2026-10-01',
    description: 'Events on or after this day (UTC).',
  })
  @IsOptional()
  @IsCalendarDate({ message: 'from must be a date like 2026-10-01' })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-10-31',
    description: 'Events on or before this day (UTC).',
  })
  @IsOptional()
  @IsCalendarDate({ message: 'to must be a date like 2026-10-31' })
  to?: string;
}

@ApiTags('Audit')
@ApiBearerAuth()
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly database: Database) {}

  @Roles(...STAFF_ROLES)
  @ApiRoute({
    summary: 'Read the audit log',
    path: '/api/v1/audit-logs',
    description:
      'Admin only. Append-only record of security, account and admin events, newest first. Filter by `action` (e.g. `auth.login_failed`, `user.suspended`, `admin.created`), `actorId`, the record it touched (`resourceType` and `resourceId`), or a day range with `from` and `to` (UTC, inclusive). Admin decisions carry `before` and `after` snapshots of the record.',
    message: 'Audit logs retrieved',
    model: AuditLogDto,
    paginated: true,
    example: {
      result: [
        {
          id: 4821,
          at: '2026-10-26T09:30:00.000Z',
          actorId: '0197c2a4-8f10-7a2b-b3c4-1d2e3f4a5b6c',
          action: 'auth.login',
          resourceType: null,
          resourceId: null,
          requestId: '0197c2a4-5b1e-7d3a-9c10-6f2e8b4a1d55',
          traceId: null,
          ip: '102.89.23.4',
          metadata: {},
          before: null,
          after: null,
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
    errors: [
      HttpStatus.BAD_REQUEST,
      HttpStatus.UNAUTHORIZED,
      HttpStatus.FORBIDDEN,
    ],
  })
  @Get()
  async list(@Query() query: AuditQueryDto): Promise<Page<AuditLogDto>> {
    const { rows, total } = await this.database.readSnapshot((tx) =>
      listAudit(tx, query, query),
    );
    return toPage(rows, total, query);
  }
}
