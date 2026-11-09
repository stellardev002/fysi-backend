import type {
  Badge,
  VendorDocumentKind,
  VendorStatus,
} from '../database/schema/index.js';

/** Statuses in which the vendor may edit business identity and documents. */
export const EDITABLE: readonly VendorStatus[] = ['draft', 'rejected'];

export const canEditIdentity = (status: VendorStatus): boolean =>
  EDITABLE.includes(status);

export interface SubmissionInput {
  businessName: string | null;
  phone: string | null;
  addressLine: string | null;
  city: string | null;
  state: string | null;
  categoryId: string | null;
  cacNumber: string | null;
  directorIdType: string | null;
  directorIdEncrypted: string | null;
  documents: { kind: VendorDocumentKind; certification: string | null }[];
}

/**
 * What still blocks submission (PRD V2 and the KYB decision): business details,
 * CAC registration, the director's NIN or BVN, the CAC certificate, and either
 * a recognised sustainability certificate or evidence for a "Fysi Reviewed" badge.
 * Empty means ready.
 */
export function missingForSubmission(v: SubmissionInput): string[] {
  const missing: string[] = [];
  const need = (ok: unknown, what: string) => {
    if (!ok) missing.push(what);
  };
  need(v.businessName, 'businessName');
  need(v.phone, 'phone');
  need(v.addressLine, 'addressLine');
  need(v.city, 'city');
  need(v.state, 'state');
  need(v.categoryId, 'categoryId');
  need(v.cacNumber, 'cacNumber');
  need(v.directorIdType && v.directorIdEncrypted, 'directorId');
  const kinds = new Set(v.documents.map((d) => d.kind));
  need(kinds.has('cac_certificate'), 'document:cac_certificate');
  need(
    kinds.has('sustainability_certificate') ||
      kinds.has('sustainability_evidence'),
    'document:sustainability_certificate_or_evidence',
  );
  return missing;
}

/** Labels the vendor uploaded certificates for, in a stable order. */
export const claimedCertifications = (
  documents: { kind: VendorDocumentKind; certification: string | null }[],
): string[] =>
  [
    ...new Set(
      documents
        .filter((d) => d.kind === 'sustainability_certificate')
        .map((d) => d.certification)
        .filter((c): c is string => !!c),
    ),
  ].sort();

/** "Certified" with at least one accepted label; otherwise "Fysi Reviewed". */
export const badgeFor = (certifications: readonly string[]): Badge =>
  certifications.length > 0 ? 'certified' : 'fysi_reviewed';

/** Admin decisions and the statuses they apply to. */
export const DECISIONS = {
  approve: { from: ['pending'], to: 'approved' },
  reject: { from: ['pending'], to: 'rejected' },
  suspend: { from: ['approved'], to: 'suspended' },
  reinstate: { from: ['suspended'], to: 'approved' },
} as const satisfies Record<
  string,
  { from: readonly VendorStatus[]; to: VendorStatus }
>;

export type VendorDecision = keyof typeof DECISIONS;
