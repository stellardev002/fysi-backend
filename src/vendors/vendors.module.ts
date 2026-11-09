import { Module } from '@nestjs/common';
import { WalletsModule } from '../wallets/wallets.module.js';
import { AdminVendorsController } from './admin-vendors.controller.js';
import { VendorController } from './vendor.controller.js';
import { VendorsService } from './vendors.service.js';

@Module({
  imports: [WalletsModule],
  controllers: [VendorController, AdminVendorsController],
  providers: [VendorsService],
  exports: [VendorsService],
})
export class VendorsModule {}
