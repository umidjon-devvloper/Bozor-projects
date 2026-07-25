import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { ApiError } from '@bozorlar/api-client';
import { SessionProvider } from '@bozorlar/session';
import { API_BASE_URL } from '@/api';
import { configureNotificationHandler } from '@/push';
import { secureRefreshStore } from '@/secureStore';
import { theme } from '@/theme';

/**
 * Passing `refreshStore` is what makes this a native client rather than a browser one: the API
 * withholds the refresh token from anything identifying as web, so an app that omitted this
 * would authenticate once and never be able to renew.
 *
 * Retries are more patient than on the web. A phone at a bazaar moves between a weak mobile
 * signal and none at all, and a request that fails because somebody walked behind a wall
 * deserves another attempt rather than an error message.
 */
configureNotificationHandler();

export default function RootLayout() {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: (failureCount, error) =>
              error instanceof ApiError ? error.isRetryable && failureCount < 3 : failureCount < 3,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={client}>
      <SessionProvider baseUrl={API_BASE_URL} refreshStore={secureRefreshStore}>
        <StatusBar style="auto" />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: theme.paper },
            headerTintColor: theme.ink,
            headerTitleStyle: { fontWeight: '700' },
            contentStyle: { backgroundColor: theme.paper },
          }}
        >
          <Stack.Screen name="index" options={{ title: 'Bozorlar' }} />
          <Stack.Screen name="market/[slug]" options={{ title: 'Bozor' }} />
          <Stack.Screen name="shop/[slug]" options={{ title: "Do'kon" }} />
          <Stack.Screen name="product/[slug]" options={{ title: 'Mahsulot' }} />
          <Stack.Screen name="qidiruv" options={{ title: 'Qidirish' }} />
          <Stack.Screen name="sevimlilar" options={{ title: 'Kuzatilayotganlar' }} />
          <Stack.Screen name="savat" options={{ title: 'Savat' }} />
          <Stack.Screen name="buyurtmalarim" options={{ title: 'Buyurtmalarim' }} />
          <Stack.Screen name="kirish" options={{ title: 'Kirish', presentation: 'modal' }} />
        </Stack>
      </SessionProvider>
    </QueryClientProvider>
  );
}
