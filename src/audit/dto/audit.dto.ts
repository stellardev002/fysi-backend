export class AuditLogDto {
  id: number;
  at: Date;
  actorId: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  requestId: string | null;
  traceId: string | null;
  ip: string | null;
  metadata: Record<string, unknown>;
  /** The record before the change, when the action captured it. */
  before: Record<string, unknown> | null;
  /** The record after the change, when the action captured it. */
  after: Record<string, unknown> | null;
}
