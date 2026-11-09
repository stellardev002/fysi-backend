import {
  BadRequestException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { detectImageType } from './image-type.js';
import type { UploadedImage } from './images.js';

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export type DocumentType = {
  ext: 'pdf' | 'jpg' | 'png' | 'webp';
  mime: string;
};

/** PDF or a JPEG / PNG / WebP scan, decided by the bytes. */
export const detectDocumentType = (b: Buffer): DocumentType | undefined => {
  if (b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-')
    return { ext: 'pdf', mime: 'application/pdf' };
  return detectImageType(b);
};

export function checkDocument(
  file: UploadedImage | undefined,
  part: string,
): DocumentType {
  if (!file)
    throw new BadRequestException(
      `Send the document as a multipart file part named "${part}"`,
    );
  const type = detectDocumentType(file.buffer);
  if (!type)
    throw new UnsupportedMediaTypeException(
      'The document must be a PDF, JPEG, PNG or WebP file',
    );
  return type;
}

/** Keeps a display name safe for headers and logs: no paths or control characters. */
export const cleanFileName = (name: string): string =>
  name
    .split(/[\\/]/)
    .pop()!
    .replace(/[^\w.\- ()]/g, '_')
    .slice(0, 120) || 'document';
