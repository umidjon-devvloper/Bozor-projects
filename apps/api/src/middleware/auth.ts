import type { NextFunction, Request, Response } from 'express';
import { AppError, ErrorCode } from '@bozorlar/errors';
import { setContextUser } from '@bozorlar/logger';
import type { SessionService } from '../modules/identity/index.js';
import type { TokenService } from '../modules/identity/index.js';
import { cookieNames } from '../modules/identity/index.js';

function extractToken(req: Request): string | null {
  const header = req.header('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  const cookie = (req.cookies as Record<string, string> | undefined)?.[cookieNames.access];
  return cookie ?? null;
}

interface Deps {
  tokens: TokenService;
  sessions: SessionService;
}

/**
 * Resolves the caller. Roles and permissions come from Redis on every request rather than
 * from the token, so a ban or role change takes effect in seconds (ADR-0013).
 */
export function authenticate({ tokens, sessions }: Deps) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const token = extractToken(req);
      if (!token) throw new AppError(ErrorCode.AUTH_REQUIRED);

      const claims = tokens.verifyAccessToken(token) as {
        sub: string;
        sid: string;
        deviceId: string;
        iat?: number;
      };

      req.auth = await sessions.resolve({
        userId: claims.sub,
        sessionId: claims.sid,
        deviceId: claims.deviceId,
        tokenIssuedAtMs: (claims.iat ?? 0) * 1000,
      });
      setContextUser(claims.sub);
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Attaches the caller when a token is present, but does not require one. */
export function optionalAuthenticate(deps: Deps) {
  const required = authenticate(deps);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!extractToken(req)) {
      next();
      return;
    }
    // `required` is an async middleware; Express ignores its return value and errors surface
    // through `next`, so the promise is discarded explicitly rather than left floating.
    void required(req, res, (error?: unknown) => {
      // A bad token on a public route is treated as anonymous rather than as an error.
      next(error && AppError.isAppError(error) ? undefined : error);
    });
  };
}

/** Double-submit CSRF for cookie-authenticated web requests (SECURITY.md). */
export function csrfProtection(req: Request, _res: Response, next: NextFunction): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    next();
    return;
  }
  const cookies = req.cookies as Record<string, string> | undefined;
  const isCookieAuth = Boolean(cookies?.[cookieNames.access]) && !req.header('authorization');
  if (!isCookieAuth) {
    next();
    return;
  }
  const headerToken = req.header('x-csrf-token');
  const cookieToken = cookies?.['bz_csrf'];
  if (!headerToken || !cookieToken || headerToken !== cookieToken) {
    next(new AppError(ErrorCode.AUTH_CSRF_INVALID, { detail: 'CSRF token missing or mismatched' }));
    return;
  }
  next();
}
