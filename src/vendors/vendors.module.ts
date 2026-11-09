import { Module } from '@nestjs/common';
import { AdminVendorsController } from './admin-vendors.controller.js';
import { VendorController } from './vendor.controller.js';
import { VendorsService } from './vendors.service.js';

@Module({
  controllers: [VendorController, AdminVendorsController],
  providers: [VendorsService],
  exports: [VendorsService],
})
export class VendorsModule {}
