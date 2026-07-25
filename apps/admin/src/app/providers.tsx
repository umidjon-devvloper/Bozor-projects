'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ApiError } from '@bozorlar/api-client';
import { SessionProvider } from '@bozorlar/session';

/**
 * Longer staleness than either of the other apps.
 *
 * Nothing here is time-critical to the minute: a moderation queue and a platform report are
 * read deliberately, not glanced at. The reports are also the most expensive queries the API
 * serves — each scans a period rather than reading a rollup — so caching them for a minute is
 * the difference between a dashboard and a load test.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60_000,
            refetchOnWindowFocus: false,
            retry: (failureCount, error) =>
              error instanceof ApiError ? error.isRetryable && failureCount < 2 : failureCount < 2,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={client}>
      <SessionProvider baseUrl={process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}>
        {children}
      </SessionProvider>
    </QueryClientProvider>
  );
}
