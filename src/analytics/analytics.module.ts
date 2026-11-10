import { Module } from '@nestjs/common';
import { ProductsModule } from '../products/products.module.js';
import { AdminAnalyticsController, VendorAnalyticsController } from './analytics.controller.js';
import { AnalyticsService } from './analytics.service.js';
import { ExportsService } from './exports.service.js';

@Module({
  imports: [ProductsModule],
  controllers: [VendorAnalyticsController, AdminAnalyticsController],
  providers: [AnalyticsService, ExportsService],
})
export class AnalyticsModule {}
