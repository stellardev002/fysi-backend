import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { RetryAfterException } from './retry-after.exception.js';
import { getRequestContext } from './request-context.js';

const PG_UNIQUE_VIOLATION = '23505';

const hasPgCode = (err: unknown, code: string): boolean => {
  let current: unknown = err;
  for (let depth = 0; depth < 3 && current; depth++) {
    if ((current as { code?: unknown }).code === code) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
};

const codeFor = (status: number): string =>
  (HttpStatus[status] ?? 'ERROR').toString();

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(AllExceptionsFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string = 'Internal server error';
    let details: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else {
        const { message: m } = body as { message?: unknown };
        if (Array.isArray(m)) {
          message = 'Validation failed';
          details = m;
        } else if (typeof m === 'string') {
          message = m;
          // e.g. `{ message, details: ['cacNumber'] }`: what is missing, by name.
          const extra = (body as { details?: unknown }).details;
          if (extra !== undefined) details = extra;
        } else {
          message = exception.message;
          // Terminus health failures carry per-indicator state in an object body.
          details = body;
        }
      }
    } else if (hasPgCode(exception, PG_UNIQUE_VIOLATION)) {
      status = HttpStatus.CONFLICT;
      message = 'Resource already exists';
    }

    const ctx = getRequestContext();
    const fields = { status, method: req.method, path: req.path };
    if (status >= 500) {
      this.logger.error(
        { ...fields, err: exception },
        `Unhandled exception: ${message}`,
      );
    } else {
      this.logger.warn(fields, `Request failed: ${message}`);
    }

    const retryAfter =
      exception instanceof RetryAfterException
        ? exception.retryAfterSeconds
        : undefined;

    if (res.headersSent) return;
    if (retryAfter !== undefined) res.setHeader('Retry-After', retryAfter);
    res.status(status).json({
      statusCode: status,
      message,
      data: null,
      error: {
        code: codeFor(status),
        details,
        requestId: ctx?.requestId,
        traceId: ctx?.traceId,
        timestamp: new Date().toISOString(),
        path: req.path,
        retryAfterSeconds: retryAfter,
      },
    });
  }
}
