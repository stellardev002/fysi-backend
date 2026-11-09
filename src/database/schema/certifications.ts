/**
 * Labels that earn the "Certified" badge (PRD decision: accepted certifications).
 * Vendors without one submit evidence instead and get "Fysi Reviewed".
 */
export const CERTIFICATIONS = [
  'gots',
  'oeko_tex',
  'fsc',
  'fairtrade',
  'rainforest_alliance',
  'eu_ecolabel',
  'usda_organic',
  'son',
] as const;

export type Certification = (typeof CERTIFICATIONS)[number];

export const CERTIFICATION_NAMES: Record<Certification, string> = {
  gots: 'GOTS',
  oeko_tex: 'OEKO-TEX',
  fsc: 'FSC',
  fairtrade: 'Fairtrade',
  rainforest_alliance: 'Rainforest Alliance',
  eu_ecolabel: 'EU Ecolabel',
  usda_organic: 'USDA Organic',
  son: 'SON product certification',
};

export const BADGES = ['certified', 'fysi_reviewed'] as const;
export type Badge = (typeof BADGES)[number];
