import { Module } from '@nestjs/common';
import { AdminMarketingController, NewsletterController } from './marketing.controller.js';
import { MarketingService } from './marketing.service.js';

@Module({
  controllers: [NewsletterController, AdminMarketingController],
  providers: [MarketingService],
  exports: [MarketingService],
})
export class MarketingModule {}
