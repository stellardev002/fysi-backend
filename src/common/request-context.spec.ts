import { parseTraceId } from './request-context.js';

describe('parseTraceId', () => {
  const trace = 'ab'.repeat(16);

  it('extracts the trace id from a valid traceparent', () => {
    expect(parseTraceId(`00-${trace}-${'cd'.repeat(8)}-01`)).toBe(trace);
  });

  it.each([
    undefined,
    '',
    'garbage',
    `01-${trace}-${'cd'.repeat(8)}-01`,
    `00-${'0'.repeat(32)}-${'cd'.repeat(8)}-01`,
    `00-${trace.toUpperCase()}-${'cd'.repeat(8)}-01`,
  ])('rejects %s', (value) => {
    expect(parseTraceId(value)).toBeUndefined();
  });
});
