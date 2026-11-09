import { Module } from '@nestjs/common';
import { AdminProductsController } from './admin-products.controller.js';
import { CatalogueController } from './catalogue.controller.js';
import { ProductsService } from './products.service.js';
import { VendorProductsController } from './vendor-products.controller.js';

@Module({
  controllers: [
    CatalogueController,
    VendorProductsController,
    AdminProductsController,
  ],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}
