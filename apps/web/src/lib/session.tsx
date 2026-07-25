'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError, createApiClient, type ApiClient, type PublicUser } from '@bozorlar/api-client';
import { Locale } from '@bozorlar/types';

/**
 * The session, held in memory and nowhere else.
 *
 * The access token is never written to `localStorage` or a readable cookie. It lives in a React
 * ref for the lifetime of the tab and disappears when the tab does. The refresh token is set by
 * the API as an httpOnly cookie, which no script can read — including one injected through a
 * cross-site scripting hole. That combination is why a stolen script cannot walk away with a
 * session: the only durable credential is unreadable, and the readable one dies with the page.
 *
 * The cost is one round trip on load, to trade the cookie for an access token. That is the
 * right trade — a marketplace holding people's phone numbers and order history should not keep
 * a long-lived credential where a single XSS bug can reach it.
 */

interface SessionState {
  user: PublicUser | null;
  status: 'loading' | 'signed-in' | 'signed-out';
  signIn: (phone: string, password: string) => Promise<void>;
  register: (input: { phone: string; password: string; name: string }) => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const accessToken = useRef<string | null>(null);
  const [user, setUser] = useState<PublicUser | null>(null);
  const [status, setStatus] = useState<SessionState['status']>('loading');

  /**
   * Renew, once, for the whole app.
   *
   * Held in a ref so that six components discovering an expired token in the same tick produce
   * one refresh rather than six — and, more importantly, so they do not race to rotate a
   * refresh token that is single-use. The second caller waits on the first one's promise.
   */
  const renewal = useRef<Promise<string | null> | null>(null);

  // Annotated explicitly: `onUnauthorized` reaches back through this ref, and without a type
  // the compiler cannot resolve a value defined in terms of itself.
  const client = useRef<ApiClient>(
    createApiClient({
      baseUrl: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000',
      locale: Locale.UZ_LATN,
      webClient: true,
      getAccessToken: () => accessToken.current,
      onUnauthorized: async (): Promise<string | null> => {
        renewal.current ??= (async (): Promise<string | null> => {
          try {
            const { data } = await client.current.auth.refresh();
            accessToken.current = data.accessToken;
            if (data.user) setUser(data.user);
            return data.accessToken;
          } catch {
            accessToken.current = null;
            setUser(null);
            setStatus('signed-out');
            return null;
          } finally {
            renewal.current = null;
          }
        })();
        return renewal.current;
      },
    }),
  );

  // One attempt on mount to turn the refresh cookie into a session. A failure here is the
  // ordinary case for a first-time visitor, not an error worth showing.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await client.current.auth.refresh();
        if (cancelled) return;
        accessToken.current = data.accessToken;
        setUser(data.user ?? null);
        setStatus('signed-in');
      } catch {
        if (!cancelled) setStatus('signed-out');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (phone: string, password: string) => {
    const { data } = await client.current.auth.login(phone, password);
    accessToken.current = data.accessToken;
    setUser(data.user ?? null);
    setStatus('signed-in');
  }, []);

  const register = useCallback(
    async (input: { phone: string; password: string; name: string }) => {
      const { data } = await client.current.auth.register(input);
      accessToken.current = data.accessToken;
      setUser(data.user ?? null);
      setStatus('signed-in');
    },
    [],
  );

  const signOut = useCallback(async () => {
    // The local session is cleared whatever the server says. A logout that appears to fail
    // because the network dropped would leave somebody looking at their own account on a
    // shared phone, believing they had signed out.
    try {
      await client.current.auth.logout();
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
    } finally {
      accessToken.current = null;
      setUser(null);
      setStatus('signed-out');
    }
  }, []);

  return (
    <SessionContext.Provider value={{ user, status, signIn, register, signOut }}>
      <ApiContext.Provider value={client.current}>{children}</ApiContext.Provider>
    </SessionContext.Provider>
  );
}

const ApiContext = createContext<ReturnType<typeof createApiClient> | null>(null);

export function useSession(): SessionState {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession used outside SessionProvider');
  return value;
}

/** The authenticated client. Components never build their own, so no request escapes renewal. */
export function useApi() {
  const value = useContext(ApiContext);
  if (!value) throw new Error('useApi used outside SessionProvider');
  return value;
}
