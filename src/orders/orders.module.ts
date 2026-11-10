import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module.js';
import { ProductsModule } from '../products/products.module.js';
import { StorefrontModule } from '../storefront/storefront.module.js';
import { SupportModule } from '../support/support.module.js';
import { WalletsModule } from '../wallets/wallets.module.js';
import { OrdersController, VendorOrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';

@Module({
  imports: [PaymentsModule, WalletsModule, ProductsModule, StorefrontModule, SupportModule],
  controllers: [OrdersController, VendorOrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}
