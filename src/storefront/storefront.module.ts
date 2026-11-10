import { Module } from '@nestjs/common';
import { ProductsModule } from '../products/products.module.js';
import { AddressesController, WishlistController } from './storefront.controller.js';
import { StorefrontService } from './storefront.service.js';

@Module({
  imports: [ProductsModule],
  controllers: [WishlistController, AddressesController],
  providers: [StorefrontService],
  exports: [StorefrontService],
})
export class StorefrontModule {}
