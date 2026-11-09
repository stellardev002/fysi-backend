export type ImageType = { ext: 'jpg' | 'png' | 'webp'; mime: string };

const JPEG = { ext: 'jpg', mime: 'image/jpeg' } as const;
const PNG = { ext: 'png', mime: 'image/png' } as const;
const WEBP = { ext: 'webp', mime: 'image/webp' } as const;

/** Decides the type from the bytes, never from the client's filename or Content-Type. */
export const detectImageType = (b: Buffer): ImageType | undefined => {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return JPEG;
  if (
    b.length >= 8 &&
    b
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return PNG;
  if (
    b.length >= 12 &&
    b.subarray(0, 4).toString('latin1') === 'RIFF' &&
    b.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return WEBP;
  return undefined;
};
