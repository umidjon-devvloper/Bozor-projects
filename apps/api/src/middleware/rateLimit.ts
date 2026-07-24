import type { NextFunction, Request, Response } from 'express';
import { AppError, ErrorCode } from '@bozorlar/errors';
import { getRedis } from '../db/redis.js';

export interface RateLimitOptions {
  /** Bucket name; keeps counters for different routes independent. */
  name: string;
  limit: number;
  windowSeconds: number;
  /** Defaults to IP. Auth routes add the phone number so one IP cannot spray many accounts. */
  keyResolver?: (req: Request) => string;
}

/**
 * Fixed-window counter in Redis. Chosen over a sliding log because it is one round trip and
 * O(1) memory; the boundary burst it permits is irrelevant at these limits (API.md Part 7).
 */
export function rateLimit(options: RateLimitOptions) {
  const { name, limit, windowSeconds, keyResolver } = options;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const identity = keyResolver ? keyResolver(req) : (req.ip ?? 'unknown');
      const window = Math.floor(Date.now() / 1000 / windowSeconds);
      const key = `rl:${name}:${identity}:${window}`;

      const redis = getRedis();
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, windowSeconds);

      const remaining = Math.max(0, limit - count);
      const reset = (window + 1) * windowSeconds;
      res.setHeader('RateLimit-Limit', limit);
      res.setHeader('RateLimit-Remaining', remaining);
      res.setHeader('RateLimit-Reset', reset);

      if (count > limit) {
        const retryAfter = reset - Math.floor(Date.now() / 1000);
        res.setHeader('Retry-After', Math.max(1, retryAfter));
        throw new AppError(ErrorCode.RATE_LIMIT_EXCEEDED, {
          detail: `Rate limit of ${limit} requests per ${windowSeconds}s exceeded`,
          params: { retryAfter },
        });
      }
      next();
    } catch (error) {
      // Redis being down must not take authentication offline. Failing open here is a
      // deliberate availability trade; the money paths have their own protections.
      if (AppError.isAppError(error)) next(error);
      else next();
    }
  };
}

export const byIpAndPhone = (req: Request): string => {
  const phone = (req.body as { phone?: string } | undefined)?.phone;
  return phone ? `${req.ip ?? 'unknown'}:${phone}` : (req.ip ?? 'unknown');
};

export const byUser = (req: Request): string => req.auth?.userId ?? req.ip ?? 'unknown';
