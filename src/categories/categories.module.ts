import { Module } from '@nestjs/common';
import {
  AdminCategoriesController,
  CategoriesController,
} from './categories.controller.js';

@Module({ controllers: [CategoriesController, AdminCategoriesController] })
export class CategoriesModule {}
