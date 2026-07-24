export const SearchCollection = {
  PRODUCTS: 'products',
  SHOPS: 'shops',
} as const;
export type SearchCollection = (typeof SearchCollection)[keyof typeof SearchCollection];

/**
 * Aliases, not collection names.
 *
 * A reindex builds a new versioned collection and then repoints the alias, so search never
 * serves a half-built index and a bad rebuild is reverted by pointing the alias back
 * (SEARCH_SYSTEM.md).
 */
export const ALIAS = {
  products: 'products',
  shops: 'shops',
} as const;

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;
export const MAX_SUGGESTIONS = 8;
/** One typo per four characters, capped: generous for short words, strict for long ones. */
export const TYPO_TOLERANCE = 2;
export const REQUEST_TIMEOUT_MS = 3_000;
export const IMPORT_BATCH_SIZE = 500;
