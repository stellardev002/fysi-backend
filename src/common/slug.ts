import { randomBytes } from 'node:crypto';

/** Lowercase ASCII words joined by hyphens, at most 60 characters. */
export const slugify = (text: string, fallback = 'item'): string =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '') || fallback;

/** 6 lowercase letters and digits, to make a slug unique without a lookup. */
export const slugSuffix = (): string => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(randomBytes(6), (b) => alphabet[b % 36]).join('');
};
