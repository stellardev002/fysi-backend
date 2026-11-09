import {
  applyDecorators,
  CallHandler,
  ExecutionContext,
  HttpStatus,
  Injectable,
  NestInterceptor,
  SetMetadata,
  StreamableFile,
  type Type,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger';
import type { Response } from 'express';
import { map, type Observable } from 'rxjs';
import { Page, PaginationMeta, toPaginationMeta } from './pagination.js';

const SSE_METADATA = '__sse__';

export const RESPONSE_MESSAGE_KEY = 'responseMessage';
const DEFAULT_MESSAGE = 'Success';

/** Sets the `message` field of the success envelope for a route or controller. */
export const ResponseMessage = (message: string) =>
  SetMetadata(RESPONSE_MESSAGE_KEY, message);

export interface SuccessResponse<T> {
  statusCode: number;
  message: string;
  data: T;
}

export interface PaginatedData<T> {
  result: T[];
  paginationMeta: PaginationMeta;
}

interface EnvelopeOptions {
  status?: number;
  paginated?: boolean;
  description?: string;
  /** Example of `data`; shown inside the full envelope. */
  example?: unknown;
  /** Example `message`, normally the route's ResponseMessage. */
  message?: string;
}

/** Documents the wire shape; the plugin would otherwise infer the unwrapped return type. */
export const ApiEnvelope = (
  model?: Type<unknown>,
  {
    status = HttpStatus.OK,
    paginated = false,
    description,
    example,
    message = DEFAULT_MESSAGE,
  }: EnvelopeOptions = {},
) => {
  const item = model ? { $ref: getSchemaPath(model) } : { type: 'object' };
  const data = paginated
    ? {
        type: 'object',
        properties: {
          result: { type: 'array', items: item },
          paginationMeta: { $ref: getSchemaPath(PaginationMeta) },
        },
      }
    : item;
  return applyDecorators(
    ApiExtraModels(PaginationMeta, ...(model ? [model] : [])),
    ApiResponse({
      status,
      description,
      schema: {
        type: 'object',
        properties: {
          statusCode: { type: 'number', example: status },
          message: { type: 'string', example: message },
          data,
        },
        ...(example !== undefined && {
          example: { statusCode: status, message, data: example },
        }),
      },
    }),
  );
};

@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    if (Reflect.getMetadata(SSE_METADATA, ctx.getHandler()))
      return next.handle();

    const message =
      this.reflector.getAllAndOverride<string | undefined>(
        RESPONSE_MESSAGE_KEY,
        [ctx.getHandler(), ctx.getClass()],
      ) ?? DEFAULT_MESSAGE;
    const res = ctx.switchToHttp().getResponse<Response>();

    return next.handle().pipe(
      map((body: unknown) => {
        if (
          res.statusCode === HttpStatus.NO_CONTENT ||
          body instanceof StreamableFile ||
          Buffer.isBuffer(body)
        )
          return body;
        const data =
          body instanceof Page
            ? { result: body.result, paginationMeta: toPaginationMeta(body) }
            : (body ?? null);
        return { statusCode: res.statusCode, message, data };
      }),
    );
  }
}
