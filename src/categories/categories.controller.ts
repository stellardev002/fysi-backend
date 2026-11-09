import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { recordAudit } from '../audit/audit.queries.js';
import { Public } from '../auth/decorators.js';
import { Roles } from '../authorization/roles.decorator.js';
import { ApiRoute } from '../common/api-docs.js';
import { Database } from '../database/database.js';
import { slugify } from '../common/slug.js';
import { STAFF_ROLES } from '../database/schema/index.js';
import {
  findCategory,
  insertCategory,
  listActiveCategories,
  listAllCategories,
  updateCategory,
} from './categories.queries.js';
import {
  AdminCategoryDto,
  CreateCategoryDto,
  PublicCategoryDto,
  UpdateCategoryDto,
} from './dto/categories.dto.js';

const CATEGORY = {
  id: '0197c2a4-5b1e-7d3a-9c10-6f2e8b4a1d55',
  name: 'Clothing',
  slug: 'clothing',
};
const ADMIN_CATEGORY = {
  ...CATEGORY,
  isActive: true,
  sortOrder: 10,
  productCount: 57,
};

@ApiTags('Categories')
@Controller('categories')
export class CategoriesController {
  constructor(private readonly database: Database) {}

  @Public()
  @ApiRoute({
    summary: 'List categories',
    path: '/api/v1/categories',
    description:
      'Active categories in display order, each with how many products customers can see in it. Use `id` in vendor and product forms (`categoryId`) and `slug` in catalogue filters (`GET /products?category=`).',
    message: 'Categories retrieved',
    model: PublicCategoryDto,
    example: [{ ...CATEGORY, productCount: 42 }],
  })
  @Get()
  list(): Promise<PublicCategoryDto[]> {
    return listActiveCategories(this.database.db);
  }
}

@ApiTags('Admin Catalogue')
@ApiBearerAuth()
@Roles(...STAFF_ROLES)
@Controller('admin/categories')
export class AdminCategoriesController {
  constructor(private readonly database: Database) {}

  @ApiRoute({
    summary: 'List all categories',
    path: '/api/v1/admin/categories',
    description:
      'Every category, inactive ones included, with how many products use it.',
    message: 'Categories retrieved',
    model: AdminCategoryDto,
    example: [ADMIN_CATEGORY],
    errors: [HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN],
  })
  @Get()
  list(): Promise<AdminCategoryDto[]> {
    return listAllCategories(this.database.db);
  }

  @ApiRoute({
    summary: 'Create a category',
    path: '/api/v1/admin/categories',
    description:
      'Names and slugs are unique. The slug defaults to one made from the name.',
    message: 'Category created',
    status: HttpStatus.CREATED,
    model: AdminCategoryDto,
    example: { ...ADMIN_CATEGORY, productCount: 0 },
    errors: [
      HttpStatus.BAD_REQUEST,
      HttpStatus.UNAUTHORIZED,
      HttpStatus.FORBIDDEN,
      {
        status: HttpStatus.CONFLICT,
        description: 'The name or slug is taken.',
      },
    ],
  })
  @Post()
  async create(@Body() dto: CreateCategoryDto): Promise<AdminCategoryDto> {
    const row = await this.database.transaction(async (tx) => {
      const created = await insertCategory(tx, {
        name: dto.name,
        slug: dto.slug ?? slugify(dto.name, 'category'),
        sortOrder: dto.sortOrder ?? 0,
      });
      await recordAudit(tx, {
        action: 'category.created',
        resourceType: 'category',
        resourceId: created.id,
        after: { name: created.name, slug: created.slug },
      });
      return created;
    });
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      isActive: row.isActive,
      sortOrder: row.sortOrder,
      productCount: 0,
    };
  }

  @ApiRoute({
    summary: 'Rename, reorder or (de)activate a category',
    path: '/api/v1/admin/categories/{id}',
    description:
      'Partial update. The slug never changes, so links keep working. Deactivating hides the category from vendors and filters; products already in it keep it.',
    message: 'Category updated',
    model: AdminCategoryDto,
    example: { ...ADMIN_CATEGORY, isActive: false },
    errors: [
      HttpStatus.BAD_REQUEST,
      HttpStatus.UNAUTHORIZED,
      HttpStatus.FORBIDDEN,
      { status: HttpStatus.NOT_FOUND, message: 'Category not found' },
      { status: HttpStatus.CONFLICT, description: 'The name is taken.' },
    ],
  })
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCategoryDto,
  ): Promise<AdminCategoryDto> {
    if (Object.values(dto).every((v) => v === undefined))
      throw new BadRequestException('No fields to update');
    await this.database.transaction(async (tx) => {
      const before = await findCategory(tx, id);
      if (!before) throw new NotFoundException('Category not found');
      const after = await updateCategory(tx, id, dto);
      await recordAudit(tx, {
        action: 'category.updated',
        resourceType: 'category',
        resourceId: id,
        before: {
          name: before.name,
          isActive: before.isActive,
          sortOrder: before.sortOrder,
        },
        after: {
          name: after!.name,
          isActive: after!.isActive,
          sortOrder: after!.sortOrder,
        },
      });
    });
    const all = await listAllCategories(this.database.db);
    return all.find((c) => c.id === id)!;
  }
}
