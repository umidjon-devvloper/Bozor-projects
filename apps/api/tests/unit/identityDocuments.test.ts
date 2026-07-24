import { describe, expect, it } from 'vitest';
import { normaliseIdentityDocuments } from '../../src/modules/onboarding/services/identityDocuments.service.js';

const valid = { passportSeries: 'AA', passportNumber: '1234567', stir: '305678912' };

describe('normaliseIdentityDocuments', () => {
  it('accepts a well-formed set and combines the passport', () => {
    const result = normaliseIdentityDocuments(valid);
    expect(result.passportFull).toBe('AA1234567');
    expect(result.stir).toBe('305678912');
  });

  it('normalises case and stray whitespace before validating', () => {
    const result = normaliseIdentityDocuments({
      passportSeries: ' aa ',
      passportNumber: ' 1234567 ',
      stir: ' 305 678 912 ',
    });
    expect(result.passportSeries).toBe('AA');
    expect(result.passportNumber).toBe('1234567');
    expect(result.stir).toBe('305678912');
  });

  it('rejects a malformed passport series', () => {
    for (const series of ['A', 'AAA', 'A1', '12', '']) {
      expect(() => normaliseIdentityDocuments({ ...valid, passportSeries: series }), series).toThrow();
    }
  });

  it('rejects a passport number that is not seven digits', () => {
    for (const number of ['123456', '12345678', 'ABCDEFG', '']) {
      expect(() => normaliseIdentityDocuments({ ...valid, passportNumber: number }), number).toThrow();
    }
  });

  it('rejects a STIR that is not nine digits', () => {
    for (const stir of ['12345678', '1234567890', 'ABCDEFGHI', '']) {
      expect(() => normaliseIdentityDocuments({ ...valid, stir }), stir).toThrow();
    }
  });

  it('rejects obvious placeholder taxpayer numbers', () => {
    // Structurally valid but typed by habit. A checksum would catch these; Uzbekistan
    // publishes none, so the known-placeholder list is the honest substitute.
    for (const stir of ['000000000', '111111111', '123456789', '999999999']) {
      expect(() => normaliseIdentityDocuments({ ...valid, stir }), stir).toThrow();
    }
  });

  it('accepts a real-shaped STIR that merely looks unusual', () => {
    // The placeholder list must not become an accidental checksum. A number with repeated
    // digits is perfectly legitimate.
    expect(() => normaliseIdentityDocuments({ ...valid, stir: '300111222' })).not.toThrow();
    expect(() => normaliseIdentityDocuments({ ...valid, stir: '200000001' })).not.toThrow();
  });

  it('reports every invalid field at once, not one per round trip', () => {
    try {
      normaliseIdentityDocuments({ passportSeries: '1', passportNumber: 'x', stir: 'y' });
      throw new Error('expected rejection');
    } catch (error) {
      const fields = (error as { errors?: Array<{ field: string }> }).errors?.map((e) => e.field);
      expect(fields).toEqual(['passportSeries', 'passportNumber', 'stir']);
    }
  });
});
