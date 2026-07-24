import { describe, expect, it } from 'vitest';
import {
  mergeAttributeSchemas,
  validateAttributes,
} from '../../src/modules/catalog/services/attributes.service.js';
import { AttributeType } from '../../src/modules/catalog/catalog.constants.js';
import type { AttributeDefinition } from '../../src/modules/catalog/models/category.model.js';

const localized = { uz: 'Nomi' };

const define = (partial: Partial<AttributeDefinition> & { key: string }): AttributeDefinition => ({
  type: AttributeType.STRING,
  name: localized,
  options: [],
  required: false,
  order: 0,
  ...partial,
});

describe('mergeAttributeSchemas', () => {
  it('lets a child override an inherited definition by key', () => {
    // "Oziq-ovqat" declares origin once; "Go'sht" narrows it. Both must not appear twice.
    const merged = mergeAttributeSchemas([
      [define({ key: 'origin', type: AttributeType.STRING })],
      [define({ key: 'origin', type: AttributeType.ENUM, options: ['uz', 'kz'] })],
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.type).toBe(AttributeType.ENUM);
  });

  it('accumulates definitions down the tree and orders them', () => {
    const merged = mergeAttributeSchemas([
      [define({ key: 'origin', order: 1 })],
      [define({ key: 'grade', order: 0 })],
    ]);
    expect(merged.map((d) => d.key)).toEqual(['grade', 'origin']);
  });
});

describe('validateAttributes', () => {
  const schema = [
    define({ key: 'origin', type: AttributeType.STRING }),
    define({ key: 'weight', type: AttributeType.NUMBER }),
    define({ key: 'organic', type: AttributeType.BOOLEAN }),
    define({ key: 'grade', type: AttributeType.ENUM, options: ['oliy', '1', '2'], required: true }),
  ];

  it('accepts and normalises a valid set', () => {
    const result = validateAttributes(
      { origin: '  Surxondaryo ', weight: '2.5', organic: true, grade: '1' },
      schema,
    );
    expect(result).toEqual({ origin: 'Surxondaryo', weight: 2.5, organic: true, grade: '1' });
  });

  it('rejects an unknown attribute instead of dropping it', () => {
    // Silently discarding seller input is how "I filled that in and it vanished" happens.
    expect(() => validateAttributes({ grade: '1', colour: 'red' }, schema)).toThrow();
  });

  it('requires attributes the category marks required', () => {
    expect(() => validateAttributes({ origin: 'Surxondaryo' }, schema)).toThrow();
  });

  it('treats empty string as absent', () => {
    expect(() => validateAttributes({ grade: '' }, schema)).toThrow(/do not match/);
  });

  it('rejects a value outside an enum\'s options', () => {
    expect(() => validateAttributes({ grade: '3' }, schema)).toThrow();
  });

  it('rejects a non-numeric number and a non-boolean boolean', () => {
    expect(() => validateAttributes({ grade: '1', weight: 'heavy' }, schema)).toThrow();
    expect(() => validateAttributes({ grade: '1', organic: 'yes' }, schema)).toThrow();
  });

  it('reports every problem at once', () => {
    try {
      validateAttributes({ weight: 'heavy', unknown: 1 }, schema);
      throw new Error('expected rejection');
    } catch (error) {
      const codes = (error as { errors?: Array<{ code: string }> }).errors?.map((e) => e.code);
      expect(codes).toEqual(
        expect.arrayContaining(['UNKNOWN_ATTRIBUTE', 'EXPECTED_NUMBER', 'REQUIRED_ATTRIBUTE']),
      );
    }
  });

  it('accepts an empty schema with empty input', () => {
    expect(validateAttributes({}, [])).toEqual({});
  });
});
