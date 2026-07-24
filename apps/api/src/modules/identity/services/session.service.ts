import type { Redis } from 'ioredis';
import { AppError, ErrorCode } from '@bozorlar/errors';
import { UserStatus } from '@bozorlar/types';
import { env } from '@bozorlar/config';
import { resolvePermissions } from '../../authz/index.js';
import { userRepository } from '../repositories/user.repository.js';
import type { AuthContext } from '../../../shared/express.js';

const CACHE_TTL_SECONDS = 300;
const identityKey = (userId: string) => `authz:user:${userId}`;
const revokedSessionKey = (sessionId: string) => `authz:revoked:${sessionId}`;

interface CachedIdentity {
  roles: string[];
  shopIds: string[];
  status: string;
  phoneVerified: boolean;
  passwordChangedAt: string;
}

/**
 * Resolves the caller's authorization state on every request.
 *
 * Cached for five minutes, so it costs one Redis GET, and invalidated explicitly on role
 * change, block, and password change. What is cached is the *inputs* to an authorization
 * decision, never a decision itself (CACHING.md).
 */
export function createSessionService(redis: Redis) {
  async function loadIdentity(userId: string): Promise<CachedIdentity> {
    const cached = await redis.get(identityKey(userId));
    if (cached) return JSON.parse(cached) as CachedIdentity;

    const user = await userRepository.findById(userId);
    if (!user) {
      throw new AppError(ErrorCode.AUTH_SESSION_REVOKED, { detail: 'User no longer exists' });
    }

    const identity: CachedIdentity = {
      roles: user.roles,
      shopIds: user.shopIds,
      status: user.status,
      phoneVerified: user.phoneVerifiedAt !== null,
      passwordChangedAt: user.passwordChangedAt.toISOString(),
    };
    await redis.set(identityKey(userId), JSON.stringify(identity), 'EX', CACHE_TTL_SECONDS);
    return identity;
  }

  return {
    async invalidateIdentity(userId: string): Promise<void> {
      await redis.del(identityKey(userId));
    },

    /**
     * Revoking a refresh token does not invalidate an access token that was already minted,
     * so logout would otherwise leave a usable token for up to 15 minutes. The denylist
     * closes that window, and its TTL matches the access-token lifetime so it stays small.
     */
    async revokeSession(sessionId: string): Promise<void> {
      await redis.set(revokedSessionKey(sessionId), '1', 'EX', env.JWT_ACCESS_TTL_SECONDS);
    },

    async resolve(input: {
      userId: string;
      sessionId: string;
      deviceId: string;
      tokenIssuedAtMs: number;
    }): Promise<AuthContext> {
      if (await redis.exists(revokedSessionKey(input.sessionId))) {
        throw new AppError(ErrorCode.AUTH_SESSION_REVOKED, { detail: 'Session was signed out' });
      }

      const identity = await loadIdentity(input.userId);

      if (identity.status === UserStatus.BLOCKED) {
        throw new AppError(ErrorCode.AUTH_USER_BLOCKED, { detail: 'This account is blocked' });
      }
      if (identity.status === UserStatus.DELETED) {
        throw new AppError(ErrorCode.AUTH_SESSION_REVOKED, { detail: 'This account was deleted' });
      }

      // A token minted before the last password change is no longer valid even if unexpired.
      // Without this, a password reset leaves a stolen token live for up to 15 minutes.
      if (new Date(identity.passwordChangedAt).getTime() > input.tokenIssuedAtMs) {
        throw new AppError(ErrorCode.AUTH_SESSION_REVOKED, {
          detail: 'Credentials changed; please sign in again',
        });
      }

      const roles = identity.roles as AuthContext['roles'];
      return {
        userId: input.userId,
        sessionId: input.sessionId,
        deviceId: input.deviceId,
        roles,
        permissions: resolvePermissions(roles),
        shopIds: identity.shopIds,
        phoneVerified: identity.phoneVerified,
      };
    },
  };
}

export type SessionService = ReturnType<typeof createSessionService>;
