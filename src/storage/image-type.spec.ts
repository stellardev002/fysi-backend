import { describe, expect, it } from 'vitest';
import { detectImageType } from './image-type.js';

describe('detectImageType', () => {
  it('reads the signature, not the name', () => {
    expect(detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))?.ext).toBe(
      'jpg',
    );
    expect(
      detectImageType(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]),
      )?.ext,
    ).toBe('png');
    expect(
      detectImageType(
        Buffer.concat([
          Buffer.from('RIFF'),
          Buffer.alloc(4),
          Buffer.from('WEBPVP8 '),
        ]),
      )?.ext,
    ).toBe('webp');
  });

  it('rejects everything else', () => {
    expect(
      detectImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')),
    ).toBeUndefined();
    expect(detectImageType(Buffer.from('GIF89a'))).toBeUndefined();
    expect(detectImageType(Buffer.alloc(0))).toBeUndefined();
    expect(detectImageType(Buffer.from('RIFF....WAVE'))).toBeUndefined();
  });
});
