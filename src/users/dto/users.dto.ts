import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  EMAIL_DOC,
  normaliseEmail,
  trim,
  VendorSummaryDto,
} from '../../auth/dto/auth.dto.js';
import { PaginationQueryDto } from '../../common/pagination.js';
import { roleEnum, type Role } from '../../database/schema/index.js';

const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

export class UsersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Matches the name or email, case-insensitive.',
    example: 'aisha',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ enum: roleEnum.enumValues })
  @IsOptional()
  @IsIn(roleEnum.enumValues)
  role?: Role;

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  suspended?: boolean;

  @ApiPropertyOptional({
    type: Boolean,
    description: '`false` finds accounts that never confirmed their email.',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  emailVerified?: boolean;
}

export class UserSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'aisha@ecothreads.ng' })
  email: string;

  @ApiProperty({ example: 'Aisha Musa' })
  name: string;

  @ApiProperty({ enum: roleEnum.enumValues })
  role: Role;

  @ApiProperty({
    nullable: true,
    description:
      'Presigned link to the profile picture; it expires, so refetch rather than store it.',
  })
  avatarUrl: string | null;

  @ApiProperty()
  emailVerified: boolean;

  @ApiProperty()
  suspended: boolean;

  @ApiProperty()
  createdAt: Date;
}

export class SuspensionDto {
  @ApiProperty({ example: 'Selling items that are not eco-friendly' })
  reason: string;

  @ApiProperty({ format: 'uuid', description: 'Admin who suspended.' })
  suspendedBy: string;

  @ApiProperty({
    nullable: true,
    example: 'Ugochinyere Eze',
    description: "That admin's name; null if the account is gone.",
  })
  suspendedByName: string | null;

  @ApiProperty()
  suspendedAt: Date;
}

export class UserDetailDto extends UserSummaryDto {
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  emailVerifiedAt: Date | null;

  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'Set when the account was deleted: personal data is gone.',
  })
  deletedAt: Date | null;

  @ApiProperty({ description: 'Last change to the name or profile picture.' })
  updatedAt: Date;

  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'Most recent password sign-in.',
  })
  lastLoginAt: Date | null;

  @ApiProperty({
    example: 2,
    description: 'Signed-in devices whose session has not expired.',
  })
  activeSessions: number;

  @ApiProperty({ nullable: true, example: '+2348031234567' })
  phone: string | null;

  @ApiProperty()
  twoFactorEnabled: boolean;

  @ApiProperty({
    type: VendorSummaryDto,
    nullable: true,
    description:
      'Business verification status for vendors; full file at `GET /admin/vendors/{id}`. Null otherwise.',
  })
  vendor: VendorSummaryDto | null;

  @ApiProperty({
    type: SuspensionDto,
    nullable: true,
    description: 'Present while the account is suspended.',
  })
  suspension: SuspensionDto | null;
}

export class CreateAdminDto {
  @ApiProperty(EMAIL_DOC)
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty({ example: 'Ugochinyere Eze', maxLength: 100 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;
}

export class CreatedAdminDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'ugo@fysi.ng' })
  email: string;

  @ApiProperty({ example: 'Ugochinyere Eze' })
  name: string;

  @ApiProperty({ enum: ['admin'] })
  role: Role;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty({
    example: 600,
    description: 'Seconds the emailed password setup code stays valid.',
  })
  otpExpiresInSeconds: number;
}

export class SuspendUserDto {
  @ApiProperty({
    example: 'Selling items that are not eco-friendly',
    minLength: 3,
    maxLength: 500,
    description: 'Kept in the audit log and shown to other admins.',
  })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}

export class ResetTwoFactorDto {
  @ApiProperty({
    example: 'Lost phone; identity confirmed on a call',
    minLength: 3,
    maxLength: 500,
    description: 'Kept in the audit log.',
  })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}

export class DeleteUserDto {
  @ApiProperty({
    example: 'Customer asked for their account to be deleted (email of 9 Nov).',
    minLength: 3,
    maxLength: 500,
    description: 'Kept in the audit log.',
  })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}
