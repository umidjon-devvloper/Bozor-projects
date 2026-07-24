import type { CollectionSchema } from './client.js';

/**
 * Index schemas.
 *
 * Every text field appears twice: the original for display and exact ranking, and a
 * normalised twin that the transliteration folds into (see normalize.ts). Queries hit both,
 * which is what lets `помидор`, `pomidor` and `Pomidor` all find the same tomato.
 *
 * Prices and quantities are `int64` and hold minor units, exactly as they do in MongoDB — a
 * float here would let the search index disagree with the catalogue about a price.
 */
export function productSchema(name: string): CollectionSchema {
  return {
    name,
    fields: [
      { name: 'id', type: 'string' },
      { name: 'name', type: 'string' },
      { name: 'nameNormalized', type: 'string' },
      { name: 'description', type: 'string', optional: true },
      { name: 'descriptionNormalized', type: 'string', optional: true },
      { name: 'tags', type: 'string[]', optional: true, facet: true },
      { name: 'shopId', type: 'string', facet: true },
      { name: 'shopName', type: 'string' },
      { name: 'shopNameNormalized', type: 'string' },
      { name: 'marketId', type: 'string', facet: true },
      { name: 'marketName', type: 'string', optional: true },
      { name: 'districtId', type: 'string', facet: true },
      { name: 'regionId', type: 'string', facet: true },
      { name: 'categoryId', type: 'string', facet: true },
      { name: 'categoryPath', type: 'string[]', facet: true },
      { name: 'categoryName', type: 'string', optional: true },
      { name: 'unit', type: 'string', facet: true },
      { name: 'price', type: 'int64', sort: true },
      { name: 'inStock', type: 'bool', facet: true },
      { name: 'rating', type: 'int32', sort: true, facet: true },
      { name: 'ratingCount', type: 'int32' },
      { name: 'salesCount', type: 'int32', sort: true },
      { name: 'imageKey', type: 'string', optional: true },
      // Sorting by proximity needs the point on the document; the shop's location is used,
      // because that is where the buyer actually has to walk.
      { name: 'location', type: 'geopoint', optional: true },
      { name: 'createdAt', type: 'int64', sort: true },
      { name: 'popularity', type: 'int32', sort: true },
    ],
    // Relevance ties break toward what people actually buy rather than toward insertion order.
    default_sorting_field: 'popularity',
  };
}

export function shopSchema(name: string): CollectionSchema {
  return {
    name,
    fields: [
      { name: 'id', type: 'string' },
      { name: 'name', type: 'string' },
      { name: 'nameNormalized', type: 'string' },
      { name: 'description', type: 'string', optional: true },
      { name: 'marketId', type: 'string', facet: true },
      { name: 'marketName', type: 'string', optional: true },
      { name: 'marketNameNormalized', type: 'string', optional: true },
      { name: 'districtId', type: 'string', facet: true },
      { name: 'regionId', type: 'string', facet: true },
      { name: 'sectionCode', type: 'string', optional: true },
      { name: 'stallNo', type: 'string', optional: true },
      { name: 'rating', type: 'int32', sort: true, facet: true },
      { name: 'ratingCount', type: 'int32' },
      { name: 'productCount', type: 'int32', sort: true },
      { name: 'salesCount', type: 'int32', sort: true },
      { name: 'logoKey', type: 'string', optional: true },
      { name: 'location', type: 'geopoint', optional: true },
      { name: 'popularity', type: 'int32', sort: true },
    ],
    default_sorting_field: 'popularity',
  };
}

/** Versioned physical name behind an alias, so a rebuild never overwrites a live index. */
export function versionedName(alias: string, at: Date = new Date()): string {
  return `${alias}_${at.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`;
}
