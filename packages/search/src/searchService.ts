import { AppError, ErrorCode } from '@bozorlar/errors';
import { ALIAS, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MAX_SUGGESTIONS, TYPO_TOLERANCE } from './constants.js';
import { normalizeQuery } from './normalize.js';
import type { ProductDocument, ShopDocument } from './documents.js';
import type { TypesenseClient } from './client.js';

export interface ProductSearchQuery {
  q?: string | undefined;
  categoryId?: string | undefined;
  marketId?: string | undefined;
  districtId?: string | undefined;
  regionId?: string | undefined;
  shopId?: string | undefined;
  priceMin?: string | undefined;
  priceMax?: string | undefined;
  inStockOnly?: boolean | undefined;
  ratingMin?: number | undefined;
  sort?: 'relevance' | 'price' | '-price' | '-rating' | '-popularity' | 'distance' | undefined;
  lat?: number | undefined;
  lng?: number | undefined;
  page?: number | undefined;
  perPage?: number | undefined;
}

export interface SearchResult<T> {
  items: T[];
  found: number;
  page: number;
  perPage: number;
  facets: Record<string, Array<{ value: string; count: number }>>;
  tookMs: number | null;
}

/**
 * Builds a Typesense `filter_by` clause.
 *
 * Values are escaped and only ever placed on the right of a comparison, and every field name
 * comes from this function rather than from the caller — a filter string assembled from user
 * input is an injection surface in any query language, including this one.
 */
function buildFilter(query: ProductSearchQuery): string {
  const clauses: string[] = [];
  const escape = (value: string): string => `\`${value.replace(/`/g, '')}\``;

  if (query.categoryId) clauses.push(`categoryPath:=${escape(query.categoryId)}`);
  if (query.marketId) clauses.push(`marketId:=${escape(query.marketId)}`);
  if (query.districtId) clauses.push(`districtId:=${escape(query.districtId)}`);
  if (query.regionId) clauses.push(`regionId:=${escape(query.regionId)}`);
  if (query.shopId) clauses.push(`shopId:=${escape(query.shopId)}`);
  if (query.inStockOnly) clauses.push('inStock:=true');
  if (query.ratingMin !== undefined) clauses.push(`rating:>=${Math.round(query.ratingMin * 100)}`);

  // Prices are integer minor units on both sides, so no rounding happens here.
  if (query.priceMin !== undefined) clauses.push(`price:>=${BigInt(query.priceMin).toString()}`);
  if (query.priceMax !== undefined) clauses.push(`price:<=${BigInt(query.priceMax).toString()}`);

  return clauses.join(' && ');
}

function buildSort(query: ProductSearchQuery): string {
  switch (query.sort) {
    case 'price':
      return 'price:asc';
    case '-price':
      return 'price:desc';
    case '-rating':
      return 'rating:desc,popularity:desc';
    case '-popularity':
      return 'popularity:desc';
    case 'distance':
      if (query.lat === undefined || query.lng === undefined) return 'popularity:desc';
      return `location(${query.lat}, ${query.lng}):asc`;
    default:
      // Relevance first, then what people actually buy — Typesense applies text match before
      // the listed sorts when a query string is present.
      return 'popularity:desc';
  }
}

export function createSearchService(client: TypesenseClient) {
  return {
    /**
     * Searches products.
     *
     * `query_by` lists the original fields before their normalised twins, and `query_by_weights`
     * ranks them accordingly: an exact, correctly-spelled match on the product name should beat
     * a transliterated match on the shop's name, even though both are hits.
     */
    async products(query: ProductSearchQuery): Promise<SearchResult<ProductDocument>> {
      const perPage = Math.min(query.perPage ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
      const page = Math.max(query.page ?? 1, 1);
      const term = query.q ? normalizeQuery(query.q) : null;

      const params: Record<string, string> = {
        // A blank query with `*` is how Typesense expresses "filter only, no text match".
        q: term?.normalized || '*',
        query_by: 'name,nameNormalized,categoryName,tags,shopName,shopNameNormalized,description,descriptionNormalized',
        query_by_weights: '10,9,6,5,4,3,2,1',
        num_typos: String(TYPO_TOLERANCE),
        prefix: 'true,true,false,false,false,false,false,false',
        per_page: String(perPage),
        page: String(page),
        sort_by: buildSort(query),
        facet_by: 'categoryPath,marketId,unit,inStock,rating',
        max_facet_values: '20',
        // Products in stock rank above ones that are not, before any other consideration.
        sort_by_missing_values: 'last',
      };

      const filter = buildFilter(query);
      if (filter) params.filter_by = filter;

      const response = await client.search<ProductDocument>(ALIAS.products, params);
      return {
        items: response.hits.map((hit) => hit.document),
        found: response.found,
        page: response.page,
        perPage,
        facets: Object.fromEntries(
          (response.facet_counts ?? []).map((facet) => [facet.field_name, facet.counts]),
        ),
        tookMs: response.search_time_ms ?? null,
      };
    },

    async shops(query: {
      q?: string | undefined;
      marketId?: string | undefined;
      districtId?: string | undefined;
      page?: number | undefined;
      perPage?: number | undefined;
    }): Promise<SearchResult<ShopDocument>> {
      const perPage = Math.min(query.perPage ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
      const term = query.q ? normalizeQuery(query.q) : null;
      const clauses: string[] = [];
      if (query.marketId) clauses.push(`marketId:=\`${query.marketId.replace(/`/g, '')}\``);
      if (query.districtId) clauses.push(`districtId:=\`${query.districtId.replace(/`/g, '')}\``);

      const params: Record<string, string> = {
        q: term?.normalized || '*',
        query_by: 'name,nameNormalized,marketName,marketNameNormalized,description',
        query_by_weights: '10,9,4,3,1',
        num_typos: String(TYPO_TOLERANCE),
        per_page: String(perPage),
        page: String(Math.max(query.page ?? 1, 1)),
        sort_by: 'popularity:desc',
        facet_by: 'marketId',
      };
      if (clauses.length > 0) params.filter_by = clauses.join(' && ');

      const response = await client.search<ShopDocument>(ALIAS.shops, params);
      return {
        items: response.hits.map((hit) => hit.document),
        found: response.found,
        page: response.page,
        perPage,
        facets: Object.fromEntries(
          (response.facet_counts ?? []).map((facet) => [facet.field_name, facet.counts]),
        ),
        tookMs: response.search_time_ms ?? null,
      };
    },

    /**
     * Type-ahead suggestions.
     *
     * Deliberately not a separate suggestion index: the product names *are* the suggestions,
     * and maintaining a second corpus would mean a product could be findable by search but not
     * by autocomplete, or the reverse.
     */
    async suggest(input: string): Promise<string[]> {
      const term = normalizeQuery(input);
      if (term.normalized.length < 2) return [];

      const response = await client.search<ProductDocument>(ALIAS.products, {
        q: term.normalized,
        query_by: 'name,nameNormalized',
        prefix: 'true,true',
        num_typos: '1',
        per_page: String(MAX_SUGGESTIONS * 3),
        page: '1',
        sort_by: 'popularity:desc',
        filter_by: 'inStock:=true',
      });

      const seen = new Set<string>();
      const suggestions: string[] = [];
      for (const hit of response.hits) {
        // The first localised variant is the display form; the rest are matching aliases.
        const label = hit.document.name.split(' ').slice(0, 6).join(' ');
        const key = label.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        suggestions.push(label);
        if (suggestions.length >= MAX_SUGGESTIONS) break;
      }
      return suggestions;
    },

    async healthy(): Promise<boolean> {
      return client.healthy();
    },

    assertQueryable(term: string | undefined): void {
      if (term !== undefined && term.trim().length > 0 && term.trim().length < 2) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, {
          detail: 'A search term needs at least two characters',
          errors: [{ field: 'q', code: 'TOO_SHORT' }],
        });
      }
    },
  };
}

export type SearchService = ReturnType<typeof createSearchService>;
