import { describe, expect, it } from 'vitest';
import {
  badgeFor,
  canEditIdentity,
  claimedCertifications,
  missingForSubmission,
  type SubmissionInput,
} from './onboarding.js';

const complete: SubmissionInput = {
  businessName: 'EcoThreads Lagos',
  phone: '+2348031234567',
  addressLine: '12 Admiralty Way',
  city: 'Lekki',
  state: 'Lagos',
  categoryId: '0197c2a4-5b1e-7d3a-9c10-6f2e8b4a1d55',
  cacNumber: 'RC1234567',
  directorIdType: 'nin',
  directorIdEncrypted: 'v1.sealed',
  documents: [
    { kind: 'cac_certificate', certification: null },
    { kind: 'sustainability_certificate', certification: 'gots' },
  ],
};

describe('vendor onboarding rules', () => {
  it('accepts a complete application', () => {
    expect(missingForSubmission(complete)).toEqual([]);
  });

  it('accepts evidence instead of a certificate (Fysi Reviewed route)', () => {
    expect(
      missingForSubmission({
        ...complete,
        documents: [
          { kind: 'cac_certificate', certification: null },
          { kind: 'sustainability_evidence', certification: null },
        ],
      }),
    ).toEqual([]);
  });

  it('names every missing piece', () => {
    expect(
      missingForSubmission({
        ...complete,
        businessName: null,
        cacNumber: '',
        directorIdEncrypted: null,
        documents: [{ kind: 'director_id', certification: null }],
      }),
    ).toEqual([
      'businessName',
      'cacNumber',
      'directorId',
      'document:cac_certificate',
      'document:sustainability_certificate_or_evidence',
    ]);
  });

  it('lets identity change only in draft or after a rejection', () => {
    expect(canEditIdentity('draft')).toBe(true);
    expect(canEditIdentity('rejected')).toBe(true);
    expect(canEditIdentity('pending')).toBe(false);
    expect(canEditIdentity('approved')).toBe(false);
    expect(canEditIdentity('suspended')).toBe(false);
  });

  it('derives claimed labels and the badge', () => {
    expect(
      claimedCertifications([
        { kind: 'sustainability_certificate', certification: 'fsc' },
        { kind: 'sustainability_certificate', certification: 'gots' },
        { kind: 'sustainability_certificate', certification: 'fsc' },
        { kind: 'sustainability_evidence', certification: null },
      ]),
    ).toEqual(['fsc', 'gots']);
    expect(badgeFor(['gots'])).toBe('certified');
    expect(badgeFor([])).toBe('fysi_reviewed');
  });
});
