import type {
  FavouriteProductView,
  MarketResponse,
  ProductResponse,
  RegionResponse,
  ShopResponse,
} from '@bozorlar/contracts';

/**
 * One typed door onto the API.
 *
 * Every response shape here comes from `@bozorlar/contracts` — the same Zod schemas the server
 * validates against. That is the whole reason the frontend lives in this repository: rename a
 * field in the API and this package stops compiling, today, while the person who renamed it is
 * still looking at the diff. A generated SDK or a hand-copied type would find out later, from a
 * user staring at an empty card.
 */

export interface ApiEnvelope<T> {
  data: T;
  meta?: { next: string | null; hasMore: boolean } | undefined;
}

export interface ApiFailure {
  error: {
    code: string;
    message: string;
    detail?: string;
    errors?: { field: string; code: string }[];
  };
}

/**
 * A failure the interface can act on.
 *
 * The server's error code is kept rather than flattened into a message, because the code is
 * what decides behaviour — `AUTH_REQUIRED` sends someone to sign in, `VALIDATION_FAILED`
 * highlights a field — and a UI that has to match on prose is a UI that breaks when the prose
 * is translated.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: string,
    readonly fields?: { field: string; code: string }[],
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Whether retrying could plausibly succeed. Used to decide what to offer the reader. */
  get isRetryable(): boolean {
    return this.status >= 500 || this.status === 429;
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  /** Sent as `Accept-Language`; the API localises `LocalizedText` from it. */
  locale?: string;
  /** Provided by the caller so this package stays free of storage and framework concerns. */
  getAccessToken?: () => string | null | undefined;
  fetchImpl?: typeof fetch;
}

export function createApiClient(options: ApiClientOptions) {
  const doFetch = options.fetchImpl ?? fetch;

  async function request<T>(
    path: string,
    init: RequestInit & { query?: Record<string, string | number | undefined> } = {},
  ): Promise<ApiEnvelope<T>> {
    const url = new URL(`${options.baseUrl.replace(/\/$/, '')}${path}`);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const token = options.getAccessToken?.();
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    if (options.locale) headers.set('Accept-Language', options.locale);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const response = await doFetch(url.toString(), { ...init, headers });
    const text = await response.text();
    const payload: unknown = text ? JSON.parse(text) : null;

    if (!response.ok) {
      const failure = payload as ApiFailure | null;
      throw new ApiError(
        response.status,
        failure?.error?.code ?? 'UNKNOWN',
        failure?.error?.message ?? response.statusText,
        failure?.error?.detail,
        failure?.error?.errors,
      );
    }

    return (payload ?? { data: null }) as ApiEnvelope<T>;
  }

  return {
    request,

    geo: {
      regions: () => request<RegionResponse[]>('/api/v1/geo/regions'),
      districts: (regionId: string) =>
        request<RegionResponse[]>(`/api/v1/geo/regions/${regionId}/districts`),
    },

    markets: {
      list: (query: { regionId?: string; districtId?: string; limit?: number } = {}) =>
        request<MarketResponse[]>('/api/v1/markets', { query }),
      get: (idOrSlug: string) => request<MarketResponse>(`/api/v1/markets/${idOrSlug}`),
    },

    shops: {
      list: (query: { marketId?: string; limit?: number; cursor?: string } = {}) =>
        request<ShopResponse[]>('/api/v1/shops', { query }),
    },

    products: {
      list: (query: { shopId?: string; categoryId?: string; limit?: number; cursor?: string } = {}) =>
        request<ProductResponse[]>('/api/v1/products', { query }),
      get: (idOrSlug: string) => request<ProductResponse>(`/api/v1/products/${idOrSlug}`),
    },

    search: {
      products: (query: { q: string; marketId?: string; limit?: number }) =>
        request<ProductResponse[]>('/api/v1/search/products', { query }),
    },

    favourites: {
      products: (query: { limit?: number; cursor?: string } = {}) =>
        request<FavouriteProductView[]>('/api/v1/favourites/products', { query }),
      add: (targetType: 'PRODUCT' | 'SHOP', targetId: string) =>
        request<{ id: string }>('/api/v1/favourites', {
          method: 'POST',
          body: JSON.stringify({ targetType, targetId }),
        }),
      remove: (targetType: 'PRODUCT' | 'SHOP', targetId: string) =>
        request<null>(`/api/v1/favourites/${targetType}/${targetId}`, { method: 'DELETE' }),
      status: (ids: string[]) =>
        request<{ followed: string[] }>('/api/v1/favourites/status', {
          query: { targetType: 'PRODUCT', ids: ids.join(',') },
        }),
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
