import { describe, expect, it } from 'vitest';
import {
  generatePickupCode,
  hashPickupCode,
  pickupCodeMatches,
} from '../../src/modules/orders/services/pickupCode.service.js';

describe('pickup code', () => {
  it('is always six digits', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generatePickupCode()).toMatch(/^\d{6}$/);
    }
  });

  it('uses the full range including leading zeros', () => {
    const codes = new Set(Array.from({ length: 500 }, () => generatePickupCode()));
    // 500 draws from a million should almost never collide into a handful of values.
    expect(codes.size).toBeGreaterThan(450);
  });

  it('stores only a hash', () => {
    const code = '483920';
    const hash = hashPickupCode(code);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain(code);
  });

  it('matches the right code and rejects the wrong one', () => {
    const hash = hashPickupCode('483920');
    expect(pickupCodeMatches('483920', hash)).toBe(true);
    expect(pickupCodeMatches('483921', hash)).toBe(false);
  });

  it('rejects a mismatched hash length without throwing', () => {
    // timingSafeEqual throws on unequal lengths; the comparison has to guard that itself.
    expect(pickupCodeMatches('483920', 'short')).toBe(false);
  });
});
