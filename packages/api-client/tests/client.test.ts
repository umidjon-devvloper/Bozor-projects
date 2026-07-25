import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from '../src/index.js';

/**
 * The request layer, tested against a stubbed `fetch`.
 *
 * This package had no tests and four applications depend on it — roughly ninety screens and
 * pages, none of which has yet spoken to a running server. The behaviours below are the ones
 * that are silently wrong rather than loudly broken: a header that is not sent, an error whose
 * code is lost on the way to the interface, a retry that fires twice or not at all.
 *
 * None of it needs a database, which is why it is worth writing now rather than waiting for an
 * environment that can run one.
 */

interface StubResponse {
  status?: number;
  body?: unknown;
}

/** A fetch that records what it was asked and answers from a queue. */
function stubFetch(...responses: StubResponse[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  let index = 0;

  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    // The client always passes a string; narrowing rather than String()-ing keeps the stub
    // from recording '[object Object]' if that ever stops being true.
    const recorded = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    calls.push({ url: recorded, init: init ?? {} });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return {
      ok: (next?.status ?? 200) < 400,
      status: next?.status ?? 200,
      statusText: 'stub',
      text: async () => (next?.body === undefined ? '' : JSON.stringify(next.body)),
    } as unknown as Response;
  });

  return { impl: impl as unknown as typeof fetch, calls };
}

const ok = (data: unknown): StubResponse => ({ status: 200, body: { data } });

describe('request construction', () => {
  it('joins the base URL without doubling the slash', async () => {
    const fetchStub = stubFetch(ok([]));
    const api = createApiClient({ baseUrl: 'http://api.test/', fetchImpl: fetchStub.impl });

    await api.markets.list();

    expect(fetchStub.calls[0]?.url).toBe('http://api.test/api/v1/markets');
  });

  it('sends the locale as Accept-Language, which is what localises the catalogue', async () => {
    const fetchStub = stubFetch(ok([]));
    const api = createApiClient({
      baseUrl: 'http://api.test',
      locale: 'uz-Cyrl',
      fetchImpl: fetchStub.impl,
    });

    await api.markets.list();

    const headers = new Headers(fetchStub.calls[0]?.init.headers);
    expect(headers.get('Accept-Language')).toBe('uz-Cyrl');
  });

  it('marks a browser client, because the API withholds the refresh token from one', async () => {
    const fetchStub = stubFetch(ok([]));
    const api = createApiClient({
      baseUrl: 'http://api.test',
      webClient: true,
      fetchImpl: fetchStub.impl,
    });

    await api.markets.list();

    const call = fetchStub.calls[0];
    expect(new Headers(call?.init.headers).get('x-client')).toBe('web');
    // Without this the cookie never travels and the session cannot be renewed.
    expect(call?.init.credentials).toBe('include');
  });

  it('omits the client marker for native, which must receive the token in the body', async () => {
    const fetchStub = stubFetch(ok([]));
    const api = createApiClient({ baseUrl: 'http://api.test', fetchImpl: fetchStub.impl });

    await api.markets.list();

    expect(new Headers(fetchStub.calls[0]?.init.headers).get('x-client')).toBeNull();
  });

  it('attaches the access token when there is one', async () => {
    const fetchStub = stubFetch(ok([]));
    const api = createApiClient({
      baseUrl: 'http://api.test',
      getAccessToken: () => 'tok_123',
      fetchImpl: fetchStub.impl,
    });

    await api.cart.get();

    expect(new Headers(fetchStub.calls[0]?.init.headers).get('Authorization')).toBe('Bearer tok_123');
  });

  it('sends no Authorization header when signed out, rather than an empty one', async () => {
    const fetchStub = stubFetch(ok([]));
    const api = createApiClient({
      baseUrl: 'http://api.test',
      getAccessToken: () => null,
      fetchImpl: fetchStub.impl,
    });

    await api.markets.list();

    expect(new Headers(fetchStub.calls[0]?.init.headers).has('Authorization')).toBe(false);
  });

  it('drops undefined query parameters instead of sending the string "undefined"', async () => {
    const fetchStub = stubFetch(ok([]));
    const api = createApiClient({ baseUrl: 'http://api.test', fetchImpl: fetchStub.impl });

    // Typed as possibly-undefined rather than written literally: `exactOptionalPropertyTypes`
    // forbids the literal, but a value threaded through from a form or a URL arrives like this.
    const limit: number | undefined = undefined;
    await api.products.list({ shopId: 'shop1', limit });

    expect(fetchStub.calls[0]?.url).toBe('http://api.test/api/v1/products?shopId=shop1');
  });

  it('carries the idempotency key on order creation', async () => {
    // The one header whose absence turns a timed-out retry into a second order.
    const fetchStub = stubFetch(ok({ orderIds: [], orderGroupId: 'g1' }));
    const api = createApiClient({ baseUrl: 'http://api.test', fetchImpl: fetchStub.impl });

    await api.orders.create('q_abc', 'key-1');

    expect(new Headers(fetchStub.calls[0]?.init.headers).get('Idempotency-Key')).toBe('key-1');
  });
});

describe('failures', () => {
  it('preserves the server error code, which is what the interface branches on', async () => {
    const fetchStub = stubFetch({
      status: 409,
      body: { error: { code: 'FAVOURITE_LIMIT_REACHED', message: 'Too many', detail: 'Max 2000' } },
    });
    const api = createApiClient({ baseUrl: 'http://api.test', fetchImpl: fetchStub.impl });

    await expect(api.favourites.add('PRODUCT', 'p1')).rejects.toMatchObject({
      code: 'FAVOURITE_LIMIT_REACHED',
      status: 409,
      detail: 'Max 2000',
    });
  });

  it('keeps field errors so a form can highlight the field that failed', async () => {
    const fetchStub = stubFetch({
      status: 422,
      body: {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Invalid',
          errors: [{ field: 'phone', code: 'INVALID_FORMAT' }],
        },
      },
    });
    const api = createApiClient({ baseUrl: 'http://api.test', fetchImpl: fetchStub.impl });

    const caught = await api.auth.login('x', 'y').catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).fields).toEqual([{ field: 'phone', code: 'INVALID_FORMAT' }]);
  });

  it('still throws a usable error when the body is not the expected envelope', async () => {
    // A proxy or gateway can return HTML. The interface must get an ApiError either way.
    const fetchStub = stubFetch({ status: 502, body: { unexpected: true } });
    const api = createApiClient({ baseUrl: 'http://api.test', fetchImpl: fetchStub.impl });

    const caught = await api.markets.list().catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).code).toBe('UNKNOWN');
  });

  it('treats 5xx and 429 as retryable and 4xx as not', async () => {
    // This drives the query layer's retry decision in all four clients.
    expect(new ApiError(500, 'X', 'x').isRetryable).toBe(true);
    expect(new ApiError(429, 'X', 'x').isRetryable).toBe(true);
    expect(new ApiError(404, 'X', 'x').isRetryable).toBe(false);
    expect(new ApiError(422, 'X', 'x').isRetryable).toBe(false);
  });
});

describe('token renewal', () => {
  it('renews once on 401 and replays the request with the new token', async () => {
    const fetchStub = stubFetch({ status: 401, body: { error: { code: 'AUTH_REQUIRED' } } }, ok({ items: [] }));
    const renew = vi.fn(async () => 'fresh_token');

    const api = createApiClient({
      baseUrl: 'http://api.test',
      getAccessToken: () => 'stale_token',
      onUnauthorized: renew,
      fetchImpl: fetchStub.impl,
    });

    await api.cart.get();

    expect(renew).toHaveBeenCalledTimes(1);
    expect(fetchStub.calls).toHaveLength(2);
    expect(new Headers(fetchStub.calls[0]?.init.headers).get('Authorization')).toBe('Bearer stale_token');
    expect(new Headers(fetchStub.calls[1]?.init.headers).get('Authorization')).toBe('Bearer fresh_token');
  });

  it('gives up after one retry rather than looping', async () => {
    // A refresh that succeeds against a server still answering 401 must not spin.
    const fetchStub = stubFetch({ status: 401, body: { error: { code: 'AUTH_REQUIRED' } } });
    const renew = vi.fn(async () => 'fresh_token');

    const api = createApiClient({
      baseUrl: 'http://api.test',
      onUnauthorized: renew,
      fetchImpl: fetchStub.impl,
    });

    await expect(api.cart.get()).rejects.toBeInstanceOf(ApiError);
    expect(fetchStub.calls).toHaveLength(2);
    expect(renew).toHaveBeenCalledTimes(1);
  });

  it('does not retry when renewal declines, because the session is genuinely over', async () => {
    const fetchStub = stubFetch({ status: 401, body: { error: { code: 'AUTH_REQUIRED' } } });
    const renew = vi.fn(async () => null);

    const api = createApiClient({
      baseUrl: 'http://api.test',
      onUnauthorized: renew,
      fetchImpl: fetchStub.impl,
    });

    await expect(api.cart.get()).rejects.toBeInstanceOf(ApiError);
    expect(fetchStub.calls).toHaveLength(1);
  });

  it('leaves other failures alone', async () => {
    const fetchStub = stubFetch({ status: 403, body: { error: { code: 'FORBIDDEN' } } });
    const renew = vi.fn(async () => 'fresh_token');

    const api = createApiClient({
      baseUrl: 'http://api.test',
      onUnauthorized: renew,
      fetchImpl: fetchStub.impl,
    });

    await expect(api.cart.get()).rejects.toBeInstanceOf(ApiError);
    expect(renew).not.toHaveBeenCalled();
  });
});

describe('request bodies', () => {
  it('sends the cart quantity as a bare minor-unit string, not an object', async () => {
    // The contract takes a string of thousandths; an object was rejected at runtime only.
    const fetchStub = stubFetch(ok({ items: [] }));
    const api = createApiClient({ baseUrl: 'http://api.test', fetchImpl: fetchStub.impl });

    await api.cart.addItem('p1', '1500');

    expect(fetchStub.calls[0]?.init.body).toBe(JSON.stringify({ productId: 'p1', qty: '1500' }));
  });

  it('omits the refresh token for web and includes it for native', async () => {
    const web = stubFetch(ok({ accessToken: 'a' }));
    await createApiClient({ baseUrl: 'http://api.test', webClient: true, fetchImpl: web.impl })
      .auth.refresh();
    expect(web.calls[0]?.init.body).toBe('{}');

    const native = stubFetch(ok({ accessToken: 'a' }));
    await createApiClient({ baseUrl: 'http://api.test', fetchImpl: native.impl })
      .auth.refresh('stored_refresh');
    expect(native.calls[0]?.init.body).toBe(JSON.stringify({ refreshToken: 'stored_refresh' }));
  });

  it('sets Content-Type only when there is a body to describe', async () => {
    const fetchStub = stubFetch(ok([]), ok(null));
    const api = createApiClient({ baseUrl: 'http://api.test', fetchImpl: fetchStub.impl });

    await api.markets.list();
    await api.favourites.remove('PRODUCT', 'p1');

    expect(new Headers(fetchStub.calls[0]?.init.headers).has('Content-Type')).toBe(false);
    expect(new Headers(fetchStub.calls[1]?.init.headers).has('Content-Type')).toBe(false);
  });
});

describe('empty responses', () => {
  it('survives a 204 with no body', async () => {
    // Deleting a favourite returns nothing; parsing '' as JSON would throw.
    const fetchStub = stubFetch({ status: 204 });
    const api = createApiClient({ baseUrl: 'http://api.test', fetchImpl: fetchStub.impl });

    await expect(api.favourites.remove('PRODUCT', 'p1')).resolves.toEqual({ data: null });
  });
});
