import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

export const MAX_PAGE_SIZE = 100;

export class PaginationQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
    default: 20,
    description: 'Page size.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit = 20;

  @ApiPropertyOptional({
    minimum: 0,
    default: 0,
    description: 'Items to skip: (page - 1) * limit.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  offset = 0;
}

export class PaginationMeta {
  @ApiProperty() nextPage: boolean;
  @ApiProperty() previousPage: boolean;
  @ApiProperty() currentPage: number;
  @ApiProperty() totalPage: number;
  @ApiProperty() totalCount: number;
  @ApiProperty() pageCount: number;
}

/** Marker class: the response interceptor wraps these as `{ result, paginationMeta }`. */
export class Page<T> {
  constructor(
    readonly result: T[],
    readonly total: number,
    readonly limit: number,
    readonly offset: number,
  ) {}
}

export const toPage = <T>(
  result: T[],
  total: number,
  q: PaginationQueryDto,
): Page<T> => new Page(result, total, q.limit, q.offset);

export const toPaginationMeta = (page: Page<unknown>): PaginationMeta => {
  const totalPage = Math.ceil(page.total / page.limit);
  const currentPage = Math.min(
    Math.floor(page.offset / page.limit) + 1,
    Math.max(totalPage, 1),
  );
  return {
    nextPage: page.offset + page.result.length < page.total,
    previousPage: page.offset > 0,
    currentPage,
    totalPage,
    totalCount: page.total,
    pageCount: page.result.length,
  };
};
