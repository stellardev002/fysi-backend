import { describe, expect, it } from 'vitest';
import { allowedOrigins } from './app.setup.js';

describe('allowedOrigins', () => {
  it('merges CORS_ORIGINS with FRONTEND_URL, trimmed and deduplicated', () => {
    expect(
      allowedOrigins(
        ' http://localhost:5173 ,https://fysi.ng/',
        'https://fysi.ng',
      ),
    ).toEqual(['http://localhost:5173', 'https://fysi.ng']);
  });

  it('is empty when nothing is configured, which disables CORS', () => {
    expect(allowedOrigins('', '')).toEqual([]);
  });
});
