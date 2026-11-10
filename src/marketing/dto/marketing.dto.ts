import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { normaliseEmail, trim, trimOrNull } from '../../auth/dto/auth.dto.js';
import { PaginationQueryDto } from '../../common/pagination.js';
import {
  campaignAudienceEnum,
  type CampaignAudience,
  campaignStatusEnum,
  type CampaignStatus,
  subscriberStatusEnum,
  type SubscriberStatus,
} from '../../database/schema/index.js';

/* ---------------- newsletter ---------------- */

export class SubscribeDto {
  @ApiProperty({ example: 'grace@example.com' })
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiPropertyOptional({ example: 'footer', description: 'Where the form was: footer, checkout, popup…' })
  @IsOptional()
  @Matches(/^[a-z0-9_-]{1,30}$/, { message: 'source must be a short lowercase label' })
  source?: string;
}

export class UnsubscribeDto {
  @ApiProperty({ example: 'grace@example.com' })
  @Transform(normaliseEmail)
  @IsEmail()
  email: string;

  @ApiProperty({ description: 'The `token` from the unsubscribe link in the email.' })
  @IsString()
  @MinLength(16)
  @MaxLength(64)
  token: string;
}

export class NewsletterStatusDto {
  @ApiProperty({ example: 'grace@example.com' }) email: string;
  @ApiProperty() subscribed: boolean;
}

export class NewsletterPreferenceDto {
  @ApiProperty({ description: 'Receive the newsletter and Fysi marketing emails.' })
  @IsBoolean()
  subscribed: boolean;
}

export class SubscribersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: subscriberStatusEnum.enumValues })
  @IsOptional()
  @IsIn(subscriberStatusEnum.enumValues)
  status?: SubscriberStatus;

  @ApiPropertyOptional({ description: 'Part of the email.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}

export class SubscriberDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() email: string;
  @ApiProperty({ enum: subscriberStatusEnum.enumValues }) status: SubscriberStatus;
  @ApiProperty({ nullable: true }) source: string | null;
  @ApiProperty({ description: 'The address has a Fysi account.' }) hasAccount: boolean;
  @ApiProperty() subscribedAt: Date;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) unsubscribedAt: Date | null;
}

/* ---------------- campaigns ---------------- */

export class CreateCampaignDto {
  @ApiProperty({ example: 'Black Friday 2026', description: 'Internal name.', maxLength: 100 })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name: string;

  @ApiProperty({ example: 'Up to 30% off certified eco products', maxLength: 150 })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(150)
  subject: string;

  @ApiPropertyOptional({ example: 'This weekend only, from verified Nigerian vendors.', maxLength: 200, nullable: true })
  @IsOptional()
  @Transform(trimOrNull)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(200)
  preheader?: string | null;

  @ApiProperty({ example: 'Black Friday on Fysi', maxLength: 150 })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(150)
  heading: string;

  @ApiProperty({
    example: 'Our vendors are taking up to 30% off.\n\nEvery product is verified eco-friendly, paid in USDC.',
    description: 'Plain text. A blank line starts a new paragraph.',
    maxLength: 10000,
  })
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(10000)
  body: string;

  @ApiPropertyOptional({ example: 'Shop the sale', maxLength: 40, nullable: true })
  @IsOptional()
  @Transform(trimOrNull)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(40)
  ctaLabel?: string | null;

  @ApiPropertyOptional({ example: 'https://fysi.ng/sale', nullable: true, description: 'https:// link for the button.' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(/^https:\/\/\S{3,500}$/, { message: 'ctaUrl must be an https:// link' })
  ctaUrl?: string | null;

  @ApiProperty({
    enum: campaignAudienceEnum.enumValues,
    description:
      '`newsletter`: subscribers. `customers` / `vendors` / `all_users`: verified, active accounts. Addresses that unsubscribed are always left out.',
  })
  @IsIn(campaignAudienceEnum.enumValues)
  audience: CampaignAudience;
}

export class UpdateCampaignDto extends PartialType(CreateCampaignDto) {}

export class SendCampaignDto {
  @ApiPropertyOptional({
    example: '2026-11-27T07:00:00.000Z',
    description: 'Send later. Omit to start within a minute.',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  scheduledAt?: Date;
}

export class TestCampaignDto {
  @ApiPropertyOptional({ example: 'me@fysi.ng', description: 'Defaults to your own address.' })
  @IsOptional()
  @Transform(normaliseEmail)
  @IsEmail()
  email?: string;
}

export class CampaignsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: campaignStatusEnum.enumValues })
  @IsOptional()
  @IsIn(campaignStatusEnum.enumValues)
  status?: CampaignStatus;
}

export class CampaignDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() name: string;
  @ApiProperty() subject: string;
  @ApiProperty({ nullable: true }) preheader: string | null;
  @ApiProperty() heading: string;
  @ApiProperty() body: string;
  @ApiProperty({ nullable: true }) ctaLabel: string | null;
  @ApiProperty({ nullable: true }) ctaUrl: string | null;
  @ApiProperty({ enum: campaignAudienceEnum.enumValues }) audience: CampaignAudience;

  @ApiProperty({
    enum: campaignStatusEnum.enumValues,
    description: '`draft` → `scheduled` → `sending` → `sent`; `cancelled` before sending.',
  })
  status: CampaignStatus;

  @ApiProperty({ example: 1240, description: 'Who would get it now (drafts), or who it went to.' })
  recipientCount: number;

  @ApiProperty({ example: 1235 }) sentCount: number;
  @ApiProperty({ example: 5 }) failedCount: number;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) scheduledAt: Date | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) sentAt: Date | null;
  @ApiProperty({ format: 'uuid' }) createdBy: string;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}
