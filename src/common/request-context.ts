import { v7 } from 'uuid';
import { randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';

export interface RequestContext {
  requestId: string;
  traceId: string;
  ip: string;
  userId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const getRequestContext = (): RequestContext | undefined =>
  storage.getStore();

const REQUEST_ID = /^[\w.-]{1,128}$/;
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;
const ZERO_TRACE_ID = '0'.repeat(32);

export function parseTraceId(header: string | undefined): string | undefined {
  const match = header ? TRACEPARENT.exec(header) : null;
  return match && match[1] !== ZERO_TRACE_ID ? match[1] : undefined;
}

export function requestContextMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const incomingId = req.headers['x-request-id'];
  const requestId =
    typeof incomingId === 'string' && REQUEST_ID.test(incomingId)
      ? incomingId
      : v7();
  const traceId =
    parseTraceId(req.headers['traceparent'] as string | undefined) ??
    randomBytes(16).toString('hex');

  (req as Request & { id: string }).id = requestId;
  res.setHeader('x-request-id', requestId);
  res.setHeader(
    'traceparent',
    `00-${traceId}-${randomBytes(8).toString('hex')}-01`,
  );

  storage.run({ requestId, traceId, ip: req.ip ?? 'unknown' }, next);
}
