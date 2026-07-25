'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ApiError } from '@bozorlar/api-client';
import { SessionProvider } from '@/lib/session';

/**
 * Query defaults tuned for a marketplace on a slow connection.
 *
 * Prices and stock move during the day, so a stale-time of a minute is a deliberate trade: the
 * page stays responsive when somebody taps back, and a shopper never sees a figure more than a
 * minute behind the stall. Retrying a 4xx is pointless and doubles the wait before an error is
 * shown, so only retryable failures are retried at all.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: false,
            retry: (failureCount, error) =>
              error instanceof ApiError ? error.isRetryable && failureCount < 2 : failureCount < 2,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={client}>
      <SessionProvider>{children}</SessionProvider>
    </QueryClientProvider>
  );
}
