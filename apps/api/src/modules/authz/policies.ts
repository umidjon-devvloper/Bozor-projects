import { AppError, ErrorCode, notFound } from '@bozorlar/errors';
import type { AuthContext } from '../../shared/express.js';

/**
 * The second authorization layer. A permission key alone never authorizes access to a
 * specific document — that gap is the classic IDOR hole (PERMISSIONS.md).
 */
export function assertOwnResource(auth: AuthContext, ownerId: string, resource: string): void {
  if (auth.userId !== ownerId) {
    // ADR-0029: report as missing so ids cannot be enumerated. The log keeps the real reason.
    throw notFound(resource, `PERM_SCOPE_DENIED user=${auth.userId} owner=${ownerId}`);
  }
}

export function assertOwnShop(auth: AuthContext, shopId: string): void {
  if (!auth.shopIds.includes(shopId)) {
    throw notFound('Shop', `PERM_SCOPE_DENIED user=${auth.userId} shop=${shopId}`);
  }
}

export function assertPhoneVerified(auth: AuthContext): void {
  if (!auth.phoneVerified) {
    throw new AppError(ErrorCode.AUTH_PHONE_NOT_VERIFIED, {
      detail: 'Verify your phone number before performing this action',
    });
  }
}
