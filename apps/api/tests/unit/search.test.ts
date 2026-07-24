import { describe, expect, it } from 'vitest';
import {
  cyrillicToLatin,
  normalizeForSearch,
  normalizeQuery,
  searchVariants,
  productSchema,
  shopSchema,
  versionedName,
} from '@bozorlar/search';

describe('Cyrillic transliteration', () => {
  it('follows the Uzbek correspondence, including the letters that differ from Russian', () => {
    // ў→o', қ→q, ғ→g', ҳ→h are the four that a naive Russian table gets wrong.
    expect(cyrillicToLatin('гўшт')).toBe("go'sht");
    expect(cyrillicToLatin('қовун')).toBe('qovun');
    expect(cyrillicToLatin('ғалла')).toBe("g'alla");
    expect(cyrillicToLatin('ҳовли')).toBe('hovli');
  });

  it('handles Russian text a buyer might type', () => {
    expect(cyrillicToLatin('помидор')).toBe('pomidor');
    expect(cyrillicToLatin('картошка')).toBe('kartoshka');
  });

  it('leaves Latin text alone', () => {
    expect(cyrillicToLatin('pomidor')).toBe('pomidor');
  });
});

describe('search normalisation', () => {
  it('makes the three ways of writing the same word collide', () => {
    // The whole point of the module: a seller lists one, a buyer types another.
    const forms = ['Goʻsht', 'гўшт', 'gosht', "go'sht", 'GOSHT'];
    const normalized = new Set(forms.map(normalizeForSearch));
    expect(normalized.size).toBe(1);
    expect([...normalized][0]).toBe('gosht');
  });

  it('folds x and h, which Uzbek writers swap routinely', () => {
    expect(normalizeForSearch('xolodilnik')).toBe(normalizeForSearch('holodilnik'));
    expect(normalizeForSearch('xiva')).toBe(normalizeForSearch('hiva'));
  });

  it('folds ts to s, so Cyrillic ц matches its Latin spelling', () => {
    expect(normalizeForSearch('ц')).toBe(normalizeForSearch('s'));
  });

  it('collapses punctuation and whitespace', () => {
    expect(normalizeForSearch('  Pomidor,   mahalliy!!! ')).toBe('pomidor mahalliy');
  });

  it('survives text with nothing indexable in it', () => {
    expect(normalizeForSearch('!!!')).toBe('');
    expect(normalizeForSearch('')).toBe('');
  });

  it('does not merge genuinely different words', () => {
    // Over-folding costs precision; these must stay apart.
    expect(normalizeForSearch('olma')).not.toBe(normalizeForSearch('olcha'));
    expect(normalizeForSearch('non')).not.toBe(normalizeForSearch('nok'));
  });
});

describe('indexed variants', () => {
  it('keeps the original for display and a canonical twin for matching', () => {
    const variants = searchVariants(['Goʻsht', 'Гўшт', 'Мясо', 'Meat']);
    expect(variants.original).toContain('Goʻsht');
    expect(variants.normalized).toContain('gosht');
    // Both Uzbek spellings fold to one token, so the canonical field is not repetitive.
    expect(variants.normalized.split(' ').filter((token) => token === 'gosht')).toHaveLength(1);
  });

  it('ignores absent locales', () => {
    const variants = searchVariants(['Pomidor', null, undefined, '  ']);
    expect(variants.original).toBe('Pomidor');
    expect(variants.normalized).toBe('pomidor');
  });
});

describe('query preparation', () => {
  it('normalises the same way the index does', () => {
    expect(normalizeQuery('  ГЎШТ  ').normalized).toBe('gosht');
  });

  it('bounds the query length', () => {
    // An unbounded query string is a cheap way to make somebody else's search slow.
    expect(normalizeQuery('a'.repeat(500)).raw.length).toBe(120);
  });
});

describe('index schemas', () => {
  it('holds money as an integer, matching the catalogue exactly', () => {
    const price = productSchema('products_x').fields.find((field) => field.name === 'price');
    // A float here would let the search index disagree with the catalogue about a price.
    expect(price?.type).toBe('int64');
    expect(price?.sort).toBe(true);
  });

  it('indexes both the original and the normalised text', () => {
    const names = productSchema('products_x').fields.map((field) => field.name);
    expect(names).toContain('name');
    expect(names).toContain('nameNormalized');
    expect(names).toContain('shopNameNormalized');
  });

  it('facets on the fields the catalogue filters by', () => {
    const faceted = productSchema('products_x')
      .fields.filter((field) => field.facet)
      .map((field) => field.name);
    expect(faceted).toEqual(
      expect.arrayContaining(['categoryPath', 'marketId', 'districtId', 'unit', 'inStock']),
    );
  });

  it('gives both collections a default sort, which Typesense requires', () => {
    expect(productSchema('p').default_sorting_field).toBe('popularity');
    expect(shopSchema('s').default_sorting_field).toBe('popularity');
  });

  it('versions physical collection names so a rebuild never overwrites a live index', () => {
    const first = versionedName('products', new Date('2026-07-24T10:00:00Z'));
    const second = versionedName('products', new Date('2026-07-24T11:00:00Z'));
    expect(first).toMatch(/^products_\d{14}$/);
    expect(first).not.toBe(second);
  });
});
