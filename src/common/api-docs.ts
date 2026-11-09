import { applyDecorators, HttpStatus, type Type } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiOperation,
  ApiProperty,
  ApiResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import { ApiEnvelope, ResponseMessage } from './response.js';

export class ErrorDetailDto {
  @ApiProperty({ example: 'BAD_REQUEST', description: 'HTTP status name.' })
  code: string;

  @ApiProperty({
    required: false,
    description:
      'Per-field validation messages, when the request body failed validation.',
    example: ['email must be an email'],
  })
  details?: unknown;

  @ApiProperty({
    required: false,
    description: 'Echo of the `x-request-id` response header.',
  })
  requestId?: string;

  @ApiProperty({
    required: false,
    description: 'W3C trace id for correlating logs.',
  })
  traceId?: string;

  @ApiProperty({ example: '2026-10-26T09:30:00.000Z' })
  timestamp: string;

  @ApiProperty({ example: '/api/v1/auth/login' })
  path: string;

  @ApiProperty({
    required: false,
    description:
      'Seconds to wait before retrying. Also sent as the `Retry-After` header.',
    example: 42,
  })
  retryAfterSeconds?: number;
}

export class ErrorResponseDto {
  @ApiProperty({ example: 400 })
  statusCode: number;

  @ApiProperty({ example: 'Validation failed' })
  message: string;

  @ApiProperty({
    nullable: true,
    type: Object,
    example: null,
    description: 'Always null on errors.',
  })
  data: null;

  @ApiProperty({ type: ErrorDetailDto })
  error: ErrorDetailDto;
}

export interface ErrorSpec {
  status: number;
  /** When the status can mean several things, say which one this route returns. */
  description?: string;
  message?: string;
  details?: unknown;
  retryAfterSeconds?: number;
}

const DEFAULTS: Record<number, { description: string; message: string }> = {
  [HttpStatus.BAD_REQUEST]: {
    description: 'The request body failed validation.',
    message: 'Validation failed',
  },
  [HttpStatus.UNAUTHORIZED]: {
    description: 'Missing, invalid, expired or revoked access token.',
    message: 'Unauthorized',
  },
  [HttpStatus.FORBIDDEN]: {
    description: 'Not allowed to perform this action.',
    message: 'Forbidden',
  },
  [HttpStatus.PAYLOAD_TOO_LARGE]: {
    description: 'The upload is too large.',
    message: 'File too large',
  },
  [HttpStatus.SERVICE_UNAVAILABLE]: {
    description: 'A dependency is unavailable.',
    message: 'Service Unavailable',
  },
  [HttpStatus.NOT_FOUND]: {
    description: 'The resource does not exist.',
    message: 'Not Found',
  },
  [HttpStatus.CONFLICT]: {
    description: 'The resource already exists.',
    message: 'Resource already exists',
  },
  [HttpStatus.TOO_MANY_REQUESTS]: {
    description:
      'Rate limit hit. Honour the `Retry-After` header before retrying.',
    message: 'Too Many Requests',
  },
};

const errorResponse = (path: string, spec: ErrorSpec | number) => {
  const { status, ...rest } =
    typeof spec === 'number' ? { status: spec } : spec;
  const d = DEFAULTS[status] ?? { description: 'Error.', message: 'Error' };
  const message = rest.message ?? d.message;
  const details =
    rest.details ??
    (status === HttpStatus.BAD_REQUEST && !rest.message
      ? ['email must be an email']
      : undefined);
  return ApiResponse({
    status,
    description: rest.description ?? d.description,
    schema: {
      allOf: [{ $ref: getSchemaPath(ErrorResponseDto) }],
      example: {
        statusCode: status,
        message,
        data: null,
        error: {
          code: HttpStatus[status] ?? 'ERROR',
          ...(details !== undefined && { details }),
          requestId: '0197c2a4-5b1e-7d3a-9c10-6f2e8b4a1d55',
          timestamp: '2026-10-26T09:30:00.000Z',
          path,
          ...(rest.retryAfterSeconds !== undefined && {
            retryAfterSeconds: rest.retryAfterSeconds,
          }),
        },
      },
    },
  });
};

/** Documents the shared error envelope for each listed status. */
export const ApiErrors = (path: string, ...specs: (ErrorSpec | number)[]) =>
  applyDecorators(
    ApiExtraModels(ErrorResponseDto, ErrorDetailDto),
    ...specs.map((spec) => errorResponse(path, spec)),
  );

export interface RouteDocs {
  summary: string;
  /** Route path shown in the error examples, e.g. `/api/v1/auth/login`. */
  path: string;
  description?: string;
  /** The success `message`, also served at runtime. */
  message: string;
  status?: number;
  model?: Type<unknown>;
  /** `data` is `{ result, paginationMeta }`; `model` is the item type. */
  paginated?: boolean;
  /** Works without a token, and a valid token still identifies the caller. */
  optionalAuth?: boolean;
  /** Example of `data`. */
  example?: unknown;
  errors?: (ErrorSpec | number)[];
}

/** One decorator for summary, runtime message, success envelope and error responses. */
export const ApiRoute = (d: RouteDocs) =>
  applyDecorators(
    ApiOperation({
      summary: d.summary,
      description: d.description,
      ...(d.optionalAuth && { security: [{ bearer: [] }, {}] }),
    }),
    ResponseMessage(d.message),
    ApiEnvelope(d.model, {
      status: d.status,
      paginated: d.paginated,
      description: 'Success.',
      example: d.example,
      message: d.message,
    }),
    ApiErrors(d.path, ...(d.errors ?? [])),
  );
