export { createTypesenseClient, type TypesenseClient, type TypesenseConfig } from './client.js';
export { createSearchService, type SearchService, type ProductSearchQuery, type SearchResult } from './searchService.js';
export { createIndexer, type SearchIndexer, type IndexerLogger } from './indexer.js';
export { productSchema, shopSchema, versionedName } from './schemas.js';
export {
  toProductDocument,
  toShopDocument,
  type ProductDocument,
  type ShopDocument,
} from './documents.js';
export {
  normalizeForSearch,
  normalizeQuery,
  cyrillicToLatin,
  searchVariants,
} from './normalize.js';
export { ALIAS, SearchCollection, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, TYPO_TOLERANCE } from './constants.js';
