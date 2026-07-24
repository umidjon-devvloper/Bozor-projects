import type { NextFunction, Request, Response } from 'express';
import { AppError, ErrorCode } from '@bozorlar/errors';
import type { Permission } from '../modules/authz/index.js';

/**
 * Layer one of authorization: does the caller hold this permission key at all?
 *
 * A missing key is a 403 — the endpoint's existence is public, so nothing leaks. Wrong
 * *resource* scope is handled by the policies in modules/authz and returns 404 (ADR-0029).
 */
export function requirePermission(...permissions: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const auth = req.auth;
    if (!auth) {
      next(new AppError(ErrorCode.AUTH_REQUIRED));
      return;
    }
    const missing = permissions.filter((permission) => !auth.permissions.has(permission));
    if (missing.length > 0) {
      next(
        new AppError(ErrorCode.PERM_DENIED, {
          detail: `Missing permission: ${missing.join(', ')}`,
          internalReason: `user=${auth.userId} roles=${auth.roles.join(',')}`,
        }),
      );
      return;
    }
    next();
  };
}
