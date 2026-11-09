import {
  BadRequestException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { detectImageType, type ImageType } from './image-type.js';
import type { ObjectStorage } from './object-storage.js';

/** A file from multer's memory storage. */
export interface UploadedImage {
  originalname: string;
  buffer: Buffer;
}

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Checks an upload is present and is a JPEG, PNG or WebP by its bytes. */
export function checkImage(
  file: UploadedImage | undefined,
  part: string,
  what: string,
): ImageType {
  if (!file)
    throw new BadRequestException(
      `Send the image as a multipart file part named "${part}"`,
    );
  const type = detectImageType(file.buffer);
  if (!type)
    throw new UnsupportedMediaTypeException(
      `The ${what} must be a JPEG, PNG or WebP image`,
    );
  return type;
}

/** A presigned read URL, or null when there is no image or it can't be signed, so reads never fail on storage. */
export async function imageUrl(
  storage: ObjectStorage,
  key: string | null | undefined,
): Promise<string | null> {
  if (!key) return null;
  try {
    return await storage.presignDownload(key);
  } catch {
    return null;
  }
}
