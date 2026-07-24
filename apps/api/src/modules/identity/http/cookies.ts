import type { Response } from 'express';
import { env, isProduction } from '@bozorlar/config';

const ACCESS_COOKIE = '__Host-bz_at';
const REFRESH_COOKIE = '__Host-bz_rt';

/**
 * Web clients receive tokens as cookies, never in a body a script can read. The __Host-
 * prefix pins the cookie to the exact origin with Secure and Path=/ (ADR-0013).
 */
export function setAuthCookies(res: Response, accessToken: string, refreshToken: string): void {
  const common = {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax' as const,
    path: '/',
  };
  res.cookie(ACCESS_COOKIE, accessToken, {
    ...common,
    maxAge: env.JWT_ACCESS_TTL_SECONDS * 1000,
  });
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...common,
    maxAge: env.REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE, { path: '/' });
  res.clearCookie(REFRESH_COOKIE, { path: '/' });
}

export const cookieNames = { access: ACCESS_COOKIE, refresh: REFRESH_COOKIE };
