import { createApiClient } from '@bozorlar/api-client';
import { Locale } from '@bozorlar/types';

/**
 * The client the app talks to.
 *
 * Base URL comes from the environment because the browser and the server render against
 * different hosts, and hard-coding either one is how a staging build ends up calling production.
 */
export const api = createApiClient({
  baseUrl: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000',
  locale: Locale.UZ_LATN,
  // Public reads only. Anything needing a session goes through `useApi()`, which holds the
  // access token; this instance deliberately has none and cannot accidentally act as a user.
});
