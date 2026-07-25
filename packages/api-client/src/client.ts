import type {
  CartResponse,
  OrderResponse,
  QuoteResponse,
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

/**
 * A search hit is not a product.
 *
 * It comes from the index rather than the catalogue: fewer fields, no slug, and a name already
 * truncated for display. Typing it separately keeps a result card from quietly expecting fields
 * the index does not carry.
 */
export interface SearchHit {
  id: string;
  name: string;
  price: { amount: string; currency: 'UZS' };
  unit: string;
  inStock: boolean;
  rating: { avg: number; count: number };
  imageUrl: string | null;
  thumbUrl: string | null;
  shop: { id: string; name: string };
  marketId: string;
  categoryId: string;
}

export interface SearchResults {
  items: SearchHit[];
  found: number;
  page: number;
  perPage: number;
  facets?: unknown;
}

export interface SellerWallet {
  id: string;
  balance: { amount: string; currency: 'UZS' };
  /** ACTIVE, GRACE or INACTIVE — an inactive wallet hides the stall from the marketplace. */
  state: string;
  lowBalanceThreshold: { amount: string; currency: 'UZS' };
  deactivateBelow: { amount: string; currency: 'UZS' };
  graceHours: number;
  lifetimeCharged: { amount: string; currency: 'UZS' };
  lifetimeCredited: { amount: string; currency: 'UZS' };
  lastEntryAt: string | null;
}

export interface SellerStatementEntry {
  id: string;
  type: string;
  amount: { amount: string; currency: 'UZS' };
  occurredAt: string;
  memo?: string | null;
}

export interface SellerStatement {
  period: { from: string; to: string; days: number };
  orders: { completed: number; cancelled: number };
  gmvMinor: string;
  commissionNetMinor: string;
  commissionChargedMinor: string;
  commissionReversedMinor: string;
  topUpMinor: string;
  adjustmentMinor: string;
  effectiveRateBp: number | null;
}

export interface QueueDepth {
  pending: number;
  stale: number;
  oldestWaitingHours: number | null;
}

export interface ModerationQueues {
  products: QueueDepth;
  sellerApplications: QueueDepth;
  disputes: QueueDepth;
}

export interface AdminOverview {
  period: { from: string; to: string; days: number };
  orders: {
    completed: number;
    cancelled: number;
    rejected: number;
    expired: number;
    pending: number;
    completionRateBp: number | null;
  };
  money: {
    gmvMinor: string;
    averageOrderMinor: string;
    commissionNetMinor: string;
    commissionChargedMinor: string;
    commissionReversedMinor: string;
    topUpMinor: string;
    effectiveRateBp: number | null;
  };
  participation: { newUsers: number; activeSellers: number };
  change: { gmvBp: number | null; commissionBp: number | null };
}

export interface AdminSellerRow {
  shopId: string;
  name: unknown;
  orders: number;
  gmvMinor: string;
  disputes: number;
  disputeRateBp: number | null;
}

export interface CommissionRule {
  id: string;
  scope: string;
  scopeId: string | null;
  percentBp: number;
  priority: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  note: string | null;
}

export interface SellerApplication {
  id: string;
  status: string;
  shopName?: unknown;
  applicantName?: string;
  phone?: string;
  createdAt: string;
  submittedAt?: string | null;
  reviewerId?: string | null;
}

export interface AdminDispute {
  id: string;
  disputeNo: string;
  status: string;
  reason: string;
  claim: string;
  orderId: string;
  orderNo?: string;
  shopId: string;
  claimedAmount?: { amount: string; currency: 'UZS' } | null;
  createdAt: string;
}

export interface PublicUser {
  id: string;
  phone: string;
  name: string;
  roles: string[];
  phoneVerified: boolean;
}

export interface SessionResponse {
  accessToken: string;
  expiresIn: number;
  tokenType: 'Bearer';
  refreshToken?: string;
  user?: PublicUser;
}

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
  /**
   * Marks this as a browser client, which changes how the API delivers tokens: with
   * `x-client: web` the refresh token is set as an httpOnly cookie and withheld from the
   * response body, so no script — including an injected one — can read it. Mobile clients omit
   * the header and receive both tokens, because they have no cookie jar.
   */
  webClient?: boolean;
  /** Called once when a request gets 401, to obtain a fresh access token before one retry. */
  onUnauthorized?: () => Promise<string | null>;
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

    const send = async (token: string | null | undefined): Promise<Response> => {
      const headers = new Headers(init.headers);
      headers.set('Accept', 'application/json');
      if (options.locale) headers.set('Accept-Language', options.locale);
      if (options.webClient) headers.set('x-client', 'web');
      if (token) headers.set('Authorization', `Bearer ${token}`);
      if (init.body && !headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }
      // The refresh cookie only travels if the request asks for it.
      const credentials = options.webClient ? 'include' : init.credentials;
      return doFetch(url.toString(), {
        ...init,
        headers,
        ...(credentials ? { credentials } : {}),
      });
    };

    let response = await send(options.getAccessToken?.());

    /**
     * One retry, and only on 401.
     *
     * An access token expires mid-session and the only civil answer is to renew it and carry on
     * rather than bounce somebody to a sign-in page holding a full basket. It is deliberately a
     * single attempt: if the refresh itself is rejected the session is genuinely over, and
     * retrying would turn one expired token into a loop.
     */
    if (response.status === 401 && options.onUnauthorized) {
      const renewed = await options.onUnauthorized();
      if (renewed) response = await send(renewed);
    }

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

    auth: {
      login: (phone: string, password: string) =>
        request<SessionResponse>('/api/v1/auth/login', {
          method: 'POST',
          body: JSON.stringify({ phone, password }),
        }),
      register: (input: { phone: string; password: string; name: string }) =>
        request<SessionResponse>('/api/v1/auth/register', {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      /** No body: the refresh token rides in the httpOnly cookie for web clients. */
      refresh: () => request<SessionResponse>('/api/v1/auth/refresh', { method: 'POST', body: '{}' }),
      logout: () => request<null>('/api/v1/auth/logout', { method: 'POST' }),
      me: () => request<PublicUser>('/api/v1/auth/me'),
    },

    cart: {
      get: () => request<CartResponse>('/api/v1/cart'),
      /** `qty` is an integer string of minor units — thousandths of the product's unit. */
      addItem: (productId: string, qty: string) =>
        request<CartResponse>('/api/v1/cart/items', {
          method: 'POST',
          body: JSON.stringify({ productId, qty }),
        }),
      updateItem: (lineId: string, qty: string) =>
        request<CartResponse>(`/api/v1/cart/items/${lineId}`, {
          method: 'PATCH',
          body: JSON.stringify({ qty }),
        }),
      removeItem: (lineId: string) =>
        request<CartResponse>(`/api/v1/cart/items/${lineId}`, { method: 'DELETE' }),
      clear: () => request<CartResponse>('/api/v1/cart', { method: 'DELETE' }),
    },

    checkout: {
      /** Holds real stock for fifteen minutes, so it is asked for once at the basket, not per keystroke. */
      quote: (lineIds?: string[]) =>
        request<QuoteResponse>('/api/v1/checkout/quote', {
          method: 'POST',
          body: JSON.stringify(lineIds ? { lineIds } : {}),
        }),
      getQuote: (quoteId: string) => request<QuoteResponse>(`/api/v1/checkout/quote/${quoteId}`),
    },

    orders: {
      /**
       * The idempotency key is required by the API, and it is the caller's job to keep it
       * stable across retries: a tap that times out on a bazaar's mobile network and is tapped
       * again must not become two orders.
       */
      create: (quoteId: string, idempotencyKey: string, note?: string) =>
        request<{ orderIds: string[]; orderGroupId: string }>('/api/v1/orders', {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey },
          body: JSON.stringify(note ? { quoteId, note } : { quoteId }),
        }),
      list: (query: { limit?: number; cursor?: string } = {}) =>
        request<OrderResponse[]>('/api/v1/orders', { query }),
      get: (id: string) => request<OrderResponse>(`/api/v1/orders/${id}`),
      confirm: (id: string) =>
        request<OrderResponse>(`/api/v1/orders/${id}/confirm`, { method: 'POST' }),
    },

    disputes: {
      raise: (input: { orderId: string; reason: string; claim: string }) =>
        request<{ id: string; disputeNo: string }>('/api/v1/disputes', {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      listMine: () => request<unknown[]>('/api/v1/disputes'),
    },

    profile: {
      update: (input: { firstName?: string; lastName?: string; locale?: string }) =>
        request<PublicUser>('/api/v1/auth/me', { method: 'PATCH', body: JSON.stringify(input) }),
    },

    seller: {
      orders: {
        list: (query: { status?: string; limit?: number } = {}) =>
          request<OrderResponse[]>('/api/v1/seller/orders', { query }),
        accept: (id: string) =>
          request<OrderResponse>(`/api/v1/seller/orders/${id}/accept`, { method: 'POST' }),
        reject: (id: string, reasonCode: string, reason: string) =>
          request<OrderResponse>(`/api/v1/seller/orders/${id}/reject`, {
            method: 'POST',
            body: JSON.stringify({ reasonCode, reason }),
          }),
        preparing: (id: string) =>
          request<OrderResponse>(`/api/v1/seller/orders/${id}/preparing`, { method: 'POST' }),
        ready: (id: string) =>
          request<OrderResponse>(`/api/v1/seller/orders/${id}/ready`, { method: 'POST' }),
        /** Six digits, shown by the buyer at the stall. Attempts are capped server-side. */
        verifyPickup: (id: string, code: string) =>
          request<OrderResponse>(`/api/v1/seller/orders/${id}/verify-pickup`, {
            method: 'POST',
            body: JSON.stringify({ code }),
          }),
      },
      products: {
        list: (query: { limit?: number } = {}) =>
          request<ProductResponse[]>('/api/v1/seller/products', { query }),
      },
      wallet: () => request<SellerWallet>('/api/v1/seller/wallet'),
      statement: (query: { limit?: number } = {}) =>
        request<{ entries: SellerStatementEntry[] }>('/api/v1/seller/wallet/statement', { query }),
      setPrice: (productId: string, price: string) =>
        request<ProductResponse>(`/api/v1/seller/products/${productId}/price`, {
          method: 'PATCH',
          body: JSON.stringify({ price }),
        }),
      setStock: (productId: string, stockQty: string) =>
        request<ProductResponse>(`/api/v1/seller/products/${productId}/stock`, {
          method: 'PATCH',
          body: JSON.stringify({ stockQty }),
        }),
      report: (query: { from?: string; to?: string } = {}) =>
        request<SellerStatement>('/api/v1/seller/reports/statement', { query }),
    },

    admin: {
      overview: (query: { from?: string; to?: string } = {}) =>
        request<AdminOverview>('/api/v1/admin/reports/overview', { query }),
      moderation: () => request<ModerationQueues>('/api/v1/admin/reports/moderation'),
      sellers: (query: { from?: string; to?: string; page?: number } = {}) =>
        request<{ sellers: AdminSellerRow[] }>('/api/v1/admin/reports/sellers', { query }),
      commissionRules: {
        list: () => request<CommissionRule[]>('/api/v1/admin/commission-rules'),
        create: (input: {
          scope: string;
          scopeId: string | null;
          percentBp: number;
          minCharge?: string | null;
          maxCharge?: string | null;
          priority: number;
          effectiveFrom: string;
          note?: string;
        }) =>
          request<CommissionRule>('/api/v1/admin/commission-rules', {
            method: 'POST',
            body: JSON.stringify(input),
          }),
      },
      productQueue: (query: { limit?: number } = {}) =>
        request<ProductResponse[]>('/api/v1/admin/products/moderation-queue', { query }),
      applications: (query: { status?: string; limit?: number } = {}) =>
        request<SellerApplication[]>('/api/v1/admin/seller-applications', { query }),
      claimApplication: (id: string) =>
        request<SellerApplication>(`/api/v1/admin/seller-applications/${id}/claim`, { method: 'POST' }),
      approveApplication: (id: string) =>
        request<SellerApplication>(`/api/v1/admin/seller-applications/${id}/approve`, { method: 'POST' }),
      rejectApplication: (id: string, reason: string) =>
        request<SellerApplication>(`/api/v1/admin/seller-applications/${id}/reject`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        }),
      disputes: (query: { status?: string; limit?: number } = {}) =>
        request<AdminDispute[]>('/api/v1/admin/disputes', { query }),
      resolveDispute: (id: string, outcome: string, reason: string, refundAmount?: string) =>
        request<AdminDispute>(`/api/v1/admin/disputes/${id}/resolve`, {
          method: 'POST',
          body: JSON.stringify(refundAmount ? { outcome, reason, refundAmount } : { outcome, reason }),
        }),
      wallet: (sellerId: string) => request<SellerWallet>(`/api/v1/admin/wallets/${sellerId}`),
      reconcileWallet: (sellerId: string) =>
        request<{ stored: { amount: string }; computed: { amount: string }; matches: boolean }>(
          `/api/v1/admin/wallets/${sellerId}/reconcile`,
          { method: 'POST' },
        ),
      setThresholds: (
        sellerId: string,
        input: { lowBalanceThreshold?: string; deactivateBelow?: string; graceHours?: number },
      ) =>
        request<SellerWallet>(`/api/v1/admin/wallets/${sellerId}/thresholds`, {
          method: 'PATCH',
          body: JSON.stringify(input),
        }),
      /**
       * A manual movement. `approvedBy` is required above the dual-control threshold and must
       * be a different administrator — the server rejects self-approval.
       */
      adjust: (input: {
        sellerId: string;
        amount: string;
        direction: 'CREDIT' | 'DEBIT';
        reason: string;
        approvedBy?: string;
      }) =>
        request<SellerWallet>('/api/v1/admin/ledger/adjustments', {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      moderateShop: (id: string, approved: boolean, reason?: string) =>
        request<unknown>(`/api/v1/admin/shops/${id}/moderate`, {
          method: 'POST',
          body: JSON.stringify(reason ? { approved, reason } : { approved }),
        }),
      searchHealth: () => request<{ healthy: boolean; collections?: unknown }>('/api/v1/admin/search/health'),
      reindex: () => request<{ accepted: boolean }>('/api/v1/admin/search/reindex', { method: 'POST' }),
      moderateProduct: (id: string, approved: boolean, reason?: string) =>
        request<unknown>(`/api/v1/admin/products/${id}/moderate`, {
          method: 'POST',
          body: JSON.stringify(reason ? { approved, reason } : { approved }),
        }),
    },

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
      inMarket: (marketId: string, query: { limit?: number; cursor?: string } = {}) =>
        request<ShopResponse[]>(`/api/v1/markets/${marketId}/shops`, { query }),
      get: (idOrSlug: string) => request<ShopResponse>(`/api/v1/shops/${idOrSlug}`),
    },

    products: {
      list: (query: { shopId?: string; categoryId?: string; limit?: number; cursor?: string } = {}) =>
        request<ProductResponse[]>('/api/v1/products', { query }),
      get: (idOrSlug: string) => request<ProductResponse>(`/api/v1/products/${idOrSlug}`),
    },

    search: {
      products: (query: {
        q?: string;
        marketId?: string;
        inStockOnly?: string;
        sort?: string;
        page?: number;
        perPage?: number;
      }) => request<SearchResults>('/api/v1/search/products', { query }),
      suggest: (q: string) => request<{ suggestions: string[] }>('/api/v1/search/suggest', { query: { q } }),
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
