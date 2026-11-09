import { Module } from '@nestjs/common';
import { ProductsModule } from '../products/products.module.js';
import { CartController } from './cart.controller.js';
import { CartService } from './cart.service.js';

@Module({
  imports: [ProductsModule],
  controllers: [CartController],
  providers: [CartService],
})
export class CartModule {}
