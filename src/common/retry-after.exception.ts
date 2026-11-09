import { HttpException, HttpStatus } from '@nestjs/common';

/** 429 with a `Retry-After` header; the exception filter reads `retryAfterSeconds`. */
export class RetryAfterException extends HttpException {
  constructor(
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(message, HttpStatus.TOO_MANY_REQUESTS);
  }
}
