import { Module } from '@nestjs/common';
import { AdminSupportController, SupportController } from './support.controller.js';
import { SupportService } from './support.service.js';

@Module({
  controllers: [SupportController, AdminSupportController],
  providers: [SupportService],
  exports: [SupportService],
})
export class SupportModule {}
