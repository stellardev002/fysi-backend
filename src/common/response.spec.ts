import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  type INestApplication,
  Post,
  StreamableFile,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toPage, toPaginationMeta } from './pagination.js';
import { ResponseInterceptor, ResponseMessage } from './response.js';

describe('toPaginationMeta', () => {
  it('middle page', () => {
    const page = toPage([1, 2], 7, { limit: 2, offset: 2 });
    expect(toPaginationMeta(page)).toEqual({
      nextPage: true,
      previousPage: true,
      currentPage: 2,
      totalPage: 4,
      totalCount: 7,
      pageCount: 2,
    });
  });

  it('offset not a multiple of limit', () => {
    expect(
      toPaginationMeta(toPage([4, 5], 5, { limit: 2, offset: 3 })),
    ).toMatchObject({ nextPage: false, previousPage: true });
    expect(
      toPaginationMeta(toPage([2, 3], 5, { limit: 2, offset: 1 })),
    ).toMatchObject({ nextPage: true, previousPage: true });
  });

  it('offset beyond total clamps currentPage', () => {
    const meta = toPaginationMeta(toPage([], 5, { limit: 2, offset: 100 }));
    expect(meta.currentPage).toBe(3);
    expect(meta.nextPage).toBe(false);
  });

  it('single page', () => {
    const page = toPage([1], 1, { limit: 20, offset: 0 });
    expect(toPaginationMeta(page)).toMatchObject({
      nextPage: false,
      previousPage: false,
      currentPage: 1,
      totalPage: 1,
    });
  });

  it('empty', () => {
    const page = toPage([], 0, { limit: 20, offset: 0 });
    expect(toPaginationMeta(page)).toMatchObject({
      nextPage: false,
      previousPage: false,
      totalPage: 0,
      pageCount: 0,
    });
  });
});

describe('ResponseInterceptor', () => {
  @Controller('t')
  class TestController {
    @ResponseMessage('Thing found')
    @Get('one')
    one() {
      return { id: 1 };
    }

    @ResponseMessage('Things found')
    @Get('many')
    many() {
      return toPage(['a', 'b'], 5, { limit: 2, offset: 2 });
    }

    @Get('file')
    file() {
      return new StreamableFile(Buffer.from('raw'));
    }

    @Get('default')
    fallback() {
      return 'x';
    }

    @HttpCode(HttpStatus.NO_CONTENT)
    @Post('none')
    none() {
      return undefined;
    }
  }

  let app: INestApplication;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [TestController],
      providers: [{ provide: APP_INTERCEPTOR, useClass: ResponseInterceptor }],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(() => app.close());

  it('wraps plain data with custom message', async () => {
    const res = await request(app.getHttpServer()).get('/t/one');
    expect(res.body).toEqual({
      statusCode: 200,
      message: 'Thing found',
      data: { id: 1 },
    });
  });

  it('wraps pages', async () => {
    const res = await request(app.getHttpServer()).get('/t/many');
    expect(res.body).toEqual({
      statusCode: 200,
      message: 'Things found',
      data: {
        result: ['a', 'b'],
        paginationMeta: {
          nextPage: true,
          previousPage: true,
          currentPage: 2,
          totalPage: 3,
          totalCount: 5,
          pageCount: 2,
        },
      },
    });
  });

  it('defaults message', async () => {
    const res = await request(app.getHttpServer()).get('/t/default');
    expect(res.body.message).toBe('Success');
  });

  it('passes files through unwrapped', async () => {
    const res = await request(app.getHttpServer()).get('/t/file');
    expect(res.body.toString()).toBe('raw');
  });

  it('leaves 204 empty', async () => {
    const res = await request(app.getHttpServer()).post('/t/none');
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
  });
});
