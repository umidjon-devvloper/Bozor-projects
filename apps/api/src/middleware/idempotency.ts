import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { AppError, ErrorCode } from '@bozorlar/errors';
import type { Logger } from '@bozorlar/logger';
import { IdempotencyKeyModel } from '../modules/platform/idempotencyKey.model.js';

const TTL_HOURS = 24;

function hashBody(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex');
}

/**
 * Makes an unsafe endpoint safe to retry (API.md 1.11).
 *
 * A buyer on a bazaar's mobile network taps "order", the request completes, and the response
 * never arrives. Without this, their retry creates a second order and a second hold on the
 * seller's stock. The unique index on `{key, userId}` is the real guarantee: two concurrent
 * retries race, one inserts, the other is told the first is in flight.
 *
 * Only successful responses are stored. A failed attempt must be retryable with the same key,
 * or a transient database error would permanently poison that key for the buyer.
 */
export function idempotency(deps: { logger: Logger }) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = req.header('idempotency-key');
    if (!key) {
      next(
        new AppError(ErrorCode.IDEMPOTENCY_KEY_REQUIRED, {
          detail: 'This endpoint requires an Idempotency-Key header',
        }),
      );
      return;
    }
    if (!req.auth) {
      next(new AppError(ErrorCode.AUTH_REQUIRED));
      return;
    }

    const userId = req.auth.userId;
    // `req.route` is untyped on Express's Request; the path is the only field read and it is
    // a string when present.
    const routePath = (req.route as { path?: string } | undefined)?.path;
    const endpoint = `${req.method} ${req.baseUrl}${routePath ?? req.path}`;
    const requestHash = hashBody(req.body);

    const record = await IdempotencyKeyModel.findOne({ key, userId }).lean<{
      requestHash: string;
      state: string;
      responseStatus: number | null;
      responseBody: Record<string, unknown> | null;
    }>();

    if (record) {
      if (record.requestHash !== requestHash) {
        // Same key, different payload. Replaying the stored response here would silently
        // throw away a genuinely different request.
        next(
          new AppError(ErrorCode.IDEMPOTENCY_KEY_REUSED, {
            detail: 'This idempotency key was already used with a different request body',
          }),
        );
        return;
      }
      if (record.state === 'IN_PROGRESS') {
        res.setHeader('Retry-After', '1');
        next(
          new AppError(ErrorCode.IDEMPOTENCY_IN_PROGRESS, {
            detail: 'An identical request is still being processed',
          }),
        );
        return;
      }
      res.setHeader('Idempotent-Replay', 'true');
      res.status(record.responseStatus ?? 200).json(record.responseBody ?? {});
      return;
    }

    try {
      await IdempotencyKeyModel.create({
        key,
        userId,
        endpoint,
        requestHash,
        expiresAt: new Date(Date.now() + TTL_HOURS * 60 * 60 * 1000),
      });
    } catch (error) {
      // Lost the insert race against a concurrent retry of the same request.
      if ((error as { code?: number }).code === 11000) {
        res.setHeader('Retry-After', '1');
        next(new AppError(ErrorCode.IDEMPOTENCY_IN_PROGRESS, { detail: 'Request already in flight' }));
        return;
      }
      next(error);
      return;
    }

    // Capture the response so a later retry can replay it verbatim.
    const originalJson = res.json.bind(res);
    res.json = (body: unknown): Response => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        void IdempotencyKeyModel.updateOne(
          { key, userId },
          {
            $set: {
              state: 'COMPLETED',
              responseStatus: res.statusCode,
              responseBody: body,
            },
          },
        ).catch((error: unknown) => {
          deps.logger.error({ err: error, key }, 'failed to record idempotent response');
        });
      } else {
        // Let the buyer retry with the same key rather than stranding it on a transient fault.
        void IdempotencyKeyModel.deleteOne({ key, userId }).catch(() => undefined);
      }
      return originalJson(body);
    };

    next();
  };
}
