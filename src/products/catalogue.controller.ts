import { Controller, Get, HttpStatus, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators.js';
import { ApiRoute } from '../common/api-docs.js';
import type { Page } from '../common/pagination.js';
import { PublicVendorDto } from '../vendors/dto/vendors.dto.js';
import {
  CatalogueQueryDto,
  ProductDetailDto,
  ProductSummaryDto,
} from './dto/products.dto.js';
import { ProductsService } from './products.service.js';

const SUMMARY_EXAMPLE = {
  id: '0197c2b0-1111-7a2b-b3c4-1d2e3f4a5b6c',
  slug: 'organic-cotton-tote-bag-k3x9qa',
  title: 'Organic cotton tote bag',
  price: { cents: 1250, usd: '12.50' },
  inStock: true,
  imageUrl:
    'https://<project>.storage.supabase.co/storage/v1/s3/fysi-media/products/…?X-Amz-Signature=…',
  badge: 'certified',
  certifications: [{ id: 'gots', name: 'GOTS' }],
  category: {
    id: '0197c2a4-5b1e-7d3a-9c10-6f2e8b4a1d55',
    name: 'Household items',
    slug: 'household',
  },
  vendor: {
    slug: 'ecothreads-lagos',
    businessName: 'EcoThreads Lagos',
    verified: true,
    badge: 'certified',
  },
  createdAt: '2026-11-08T09:30:00.000Z',
};

@ApiTags('Catalogue')
@Controller()
@Public()
export class CatalogueController {
  constructor(private readonly products: ProductsService) {}

  @ApiRoute({
    summary: 'Browse and search products',
    path: '/api/v1/products',
    description: `Public, no account needed (PRD C1–C2). Only products of verified stores that are on sale.

- \`q\` searches titles and descriptions (partial words match titles).
- Filters: \`category\` (slug), \`vendor\` (store slug), \`minPriceCents\`/\`maxPriceCents\`, \`certified\`, \`inStock\`.
- \`sort\`: \`newest\` (default; the "New in" view), \`price_asc\`, \`price_desc\`, \`relevance\` (default with \`q\`).
- Prices are US dollars (\`price.usd\`) and cents (\`price.cents\`), paid 1:1 in USDC.`,
    message: 'Products retrieved',
    model: ProductSummaryDto,
    paginated: true,
    example: {
      result: [SUMMARY_EXAMPLE],
      paginationMeta: {
        nextPage: false,
        previousPage: false,
        currentPage: 1,
        totalPage: 1,
        totalCount: 1,
        pageCount: 1,
      },
    },
    errors: [
      {
        status: HttpStatus.BAD_REQUEST,
        description: 'Invalid filter, or min price above max price.',
        message: 'minPriceCents is above maxPriceCents',
      },
    ],
  })
  @Get('products')
  list(@Query() query: CatalogueQueryDto): Promise<Page<ProductSummaryDto>> {
    return this.products.catalogue(query);
  }

  @ApiRoute({
    summary: 'Product page',
    path: '/api/v1/products/{slug}',
    description:
      'Everything for the product page (PRD C3): all photos, description, stock, certification badge, the verified vendor, price in US dollars (paid 1:1 in USDC). 404 when the product is hidden, removed, or its store is not verified.',
    message: 'Product retrieved',
    model: ProductDetailDto,
    example: {
      ...SUMMARY_EXAMPLE,
      description: 'Hand-stitched from GOTS-certified cotton. Holds 15 kg.',
      stock: 40,
      images: [
        {
          id: '0197c2b0-2222-7a2b-b3c4-1d2e3f4a5b6c',
          url: 'https://<project>.storage.supabase.co/…',
          position: 0,
        },
      ],
      vendor: {
        ...SUMMARY_EXAMPLE.vendor,
        logoUrl: null,
        city: 'Lekki',
        state: 'Lagos',
      },
    },
    errors: [{ status: HttpStatus.NOT_FOUND, message: 'Product not found' }],
  })
  @Get('products/:slug')
  get(@Param('slug') slug: string): Promise<ProductDetailDto> {
    return this.products.productPage(slug);
  }

  @ApiRoute({
    summary: 'Store page',
    path: '/api/v1/vendors/{slug}',
    description:
      'A verified store: name, story, logo, location, badge and certifications. List its products with `GET /products?vendor={slug}`.',
    message: 'Store retrieved',
    model: PublicVendorDto,
    example: {
      slug: 'ecothreads-lagos',
      businessName: 'EcoThreads Lagos',
      description: 'Handmade clothing from organic cotton and recycled fabric.',
      logoUrl: null,
      city: 'Lekki',
      state: 'Lagos',
      category: {
        id: '0197c2a4-5b1e-7d3a-9c10-6f2e8b4a1d55',
        name: 'Clothing',
        slug: 'clothing',
      },
      badge: 'certified',
      certifications: [{ id: 'gots', name: 'GOTS' }],
      productCount: 14,
      verifiedSince: '2026-11-08T09:30:00.000Z',
    },
    errors: [{ status: HttpStatus.NOT_FOUND, message: 'Store not found' }],
  })
  @Get('vendors/:slug')
  store(@Param('slug') slug: string): Promise<PublicVendorDto> {
    return this.products.storefront(slug);
  }
}
