import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { AppError, ErrorCode } from '@bozorlar/errors';
import { env, getJwtKeys } from '@bozorlar/config';
import { TokenRevokeReason } from '@bozorlar/types';
import type { Logger } from '@bozorlar/logger';
import { refreshTokenRepository } from '../repositories/refreshToken.repository.js';

export interface AccessTokenClaims {
  sub: string;
  sid: string;
  deviceId: string;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  sessionId: string;
}

const ISSUER = 'bozorlar';
const AUDIENCE = 'bozorlar-api';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createTokenService(logger: Logger) {
  const keys = getJwtKeys();

  function signAccessToken(claims: AccessTokenClaims): string {
    // Deliberately no roles or permissions in the claims: they are resolved per request from
    // Redis, so a ban takes effect in seconds instead of waiting out the token TTL (ADR-0013).
    return jwt.sign(claims, keys.privateKey, {
      algorithm: 'RS256',
      expiresIn: env.JWT_ACCESS_TTL_SECONDS,
      issuer: ISSUER,
      audience: AUDIENCE,
      jwtid: randomBytes(12).toString('hex'),
    });
  }

  return {
    verifyAccessToken(token: string): AccessTokenClaims {
      try {
        return jwt.verify(token, keys.publicKey, {
          algorithms: ['RS256'],
          issuer: ISSUER,
          audience: AUDIENCE,
        }) as AccessTokenClaims;
      } catch (cause) {
        if (cause instanceof jwt.TokenExpiredError) {
          throw new AppError(ErrorCode.AUTH_TOKEN_EXPIRED, { detail: 'Access token expired' });
        }
        throw new AppError(ErrorCode.AUTH_TOKEN_INVALID, { detail: 'Access token invalid', cause });
      }
    },

    async issue(input: {
      userId: string;
      deviceId: string;
      familyId?: string;
      parentId?: string;
      ip?: string | null;
      userAgent?: string | null;
    }): Promise<IssuedTokens> {
      const refreshToken = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + env.REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);

      const record = await refreshTokenRepository.create({
        userId: input.userId,
        ...(input.familyId !== undefined ? { familyId: input.familyId } : {}),
        tokenHash: hashToken(refreshToken),
        deviceId: input.deviceId,
        ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        expiresAt,
      });

      return {
        accessToken: signAccessToken({
          sub: input.userId,
          sid: record.id,
          deviceId: input.deviceId,
        }),
        refreshToken,
        expiresIn: env.JWT_ACCESS_TTL_SECONDS,
        sessionId: record.id,
      };
    },

    /**
     * Rotates a refresh token.
     *
     * The security-critical branch is reuse detection: presenting a token that has already
     * been consumed means either the client replayed it or an attacker stole it. We cannot
     * distinguish the two, so we assume theft and revoke the whole family. That is the
     * mechanism which makes a stolen refresh token survivable (ADR-0013).
     */
    async rotate(
      presentedToken: string,
      context: { ip?: string | null; userAgent?: string | null },
    ): Promise<IssuedTokens & { userId: string }> {
      const tokenHash = hashToken(presentedToken);
      const record = await refreshTokenRepository.findByHash(tokenHash);

      if (!record) {
        throw new AppError(ErrorCode.AUTH_REFRESH_INVALID, { detail: 'Unknown refresh token' });
      }

      if (record.usedAt !== null) {
        const revoked = await refreshTokenRepository.revokeFamily(
          record.familyId,
          TokenRevokeReason.REUSE_DETECTED,
        );
        logger.warn(
          { userId: record.userId, familyId: record.familyId, revoked },
          'refresh token reuse detected; family revoked',
        );
        throw new AppError(ErrorCode.AUTH_REFRESH_REUSE_DETECTED, {
          detail: 'This session has been terminated for security reasons. Please sign in again.',
        });
      }

      if (record.revokedAt !== null) {
        throw new AppError(ErrorCode.AUTH_SESSION_REVOKED, { detail: 'Session revoked' });
      }
      if (record.expiresAt.getTime() < Date.now()) {
        throw new AppError(ErrorCode.AUTH_REFRESH_INVALID, { detail: 'Refresh token expired' });
      }

      // Atomic: two concurrent refreshes cannot both consume the same token. The loser sees
      // usedAt set on its next attempt and is correctly treated as reuse.
      if (!(await refreshTokenRepository.consume(record.id))) {
        throw new AppError(ErrorCode.AUTH_REFRESH_INVALID, {
          detail: 'Refresh token was consumed concurrently',
        });
      }

      const issued = await this.issue({
        userId: record.userId,
        deviceId: record.deviceId,
        familyId: record.familyId,
        parentId: record.id,
        ip: context.ip ?? null,
        userAgent: context.userAgent ?? null,
      });
      return { ...issued, userId: record.userId };
    },

    async revokeSession(sessionId: string, userId: string): Promise<boolean> {
      return refreshTokenRepository.revokeById(sessionId, userId, TokenRevokeReason.LOGOUT);
    },

    async revokeAll(userId: string, reason: TokenRevokeReason): Promise<number> {
      return refreshTokenRepository.revokeAllForUser(userId, reason);
    },
  };
}

export type TokenService = ReturnType<typeof createTokenService>;
