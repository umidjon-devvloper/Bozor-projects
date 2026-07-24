import { describe, expect, it } from 'vitest';
import { generateUniqueSlug, slugify } from '../../src/modules/geo/services/slug.js';

describe('slugify', () => {
  it('drops Uzbek modifier letters instead of turning them into hyphens', () => {
    // The naive implementation yields "o-zbekiston-do-koni", which is unusable as a URL.
    expect(slugify("Oʻzbekiston doʻkoni")).toBe('ozbekiston-dokoni');
    expect(slugify("Gʻalaba bozori")).toBe('galaba-bozori');
  });

  it('transliterates Cyrillic so a Cyrillic-named shop still gets a usable slug', () => {
    expect(slugify('Чорсу бозори')).toBe('chorsu-bozori');
    expect(slugify('Мясная лавка')).toBe('myasnaya-lavka');
  });

  it('collapses punctuation and trims hyphens', () => {
    expect(slugify('  Aziz --- sabzavot!!!  ')).toBe('aziz-sabzavot');
  });

  it('caps length', () => {
    expect(slugify('a'.repeat(200))).toHaveLength(100);
  });
});

describe('generateUniqueSlug', () => {
  it('returns the plain slug when it is free', async () => {
    expect(await generateUniqueSlug('Aziz sabzavot', async () => false)).toBe('aziz-sabzavot');
  });

  it('suffixes when taken', async () => {
    const taken = new Set(['aziz-sabzavot']);
    const slug = await generateUniqueSlug('Aziz sabzavot', async (c) => taken.has(c));
    expect(slug).toMatch(/^aziz-sabzavot-[a-z0-9]{4}$/);
  });

  it('always produces something for input with no latin characters', async () => {
    expect(await generateUniqueSlug('!!!', async () => false)).toBe('shop');
  });
});
