'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ApiError } from '@bozorlar/api-client';
import { SessionProvider } from '@bozorlar/session';

/**
 * Shorter staleness than the marketplace, on purpose.
 *
 * A shopper can look at a minute-old price without harm. A seller working their morning queue
 * cannot: an order that arrived thirty seconds ago and is not on screen is a customer standing
 * at the stall while the tablet says there is nothing to do.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5_000,
            refetchOnWindowFocus: true,
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
