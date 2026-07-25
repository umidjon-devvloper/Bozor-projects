import { cookies } from 'next/headers';
import { createApiClient } from '@bozorlar/api-client';
import { LOCALE_COOKIE, parseLocale } from './locale';

/**
 * The client server components use.
 *
 * Built per request rather than once at module scope, because the language comes from the
 * reader's cookie and a shared instance would serve one visitor's language to the next. It
 * carries no access token by design: anything needing a session goes through `useApi()` in the
 * browser, so a server render can never accidentally act as a user.
 */
export async function serverApi() {
  const store = await cookies();
  return createApiClient({
    baseUrl: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000',
    locale: parseLocale(store.get(LOCALE_COOKIE)?.value),
  });
}
