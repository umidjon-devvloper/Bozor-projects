import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '../../src/http/cursor.js';

describe('cursor pagination', () => {
  const payload = { v: 1 as const, s: '-createdAt', k: ['2026-07-23T10:00:00Z', 'abc'] };

  it('round-trips', () => {
    expect(decodeCursor(encodeCursor(payload), '-createdAt')).toEqual(payload);
  });

  it('rejects a tampered cursor rather than executing it', () => {
    const cursor = encodeCursor(payload);
    const tampered = `${Buffer.from('{"v":1,"s":"-createdAt","k":["x"]}').toString('base64url')}.${cursor.split('.')[1]}`;
    expect(() => decodeCursor(tampered, '-createdAt')).toThrow(/signature/i);
  });

  it('rejects a cursor issued for a different sort', () => {
    expect(() => decodeCursor(encodeCursor(payload), 'price')).toThrow();
  });

  it('rejects malformed input', () => {
    expect(() => decodeCursor('not-a-cursor', '-createdAt')).toThrow();
  });
});
