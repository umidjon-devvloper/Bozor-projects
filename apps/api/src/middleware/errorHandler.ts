import type { NextFunction, Request, Response } from 'express';
import { AppError, ErrorCode } from '@bozorlar/errors';
import type { Logger } from '@bozorlar/logger';
import { getContext } from '@bozorlar/logger';
import { isProduction } from '@bozorlar/config';

const DOCS_BASE = 'https://docs.bozorlar.uz/errors';

/** Mongo duplicate-key errors are a normal outcome of unique constraints, not a crash. */
function isDuplicateKeyError(error: unknown): error is { code: number; keyPattern?: object } {
  return typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000;
}

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new AppError(ErrorCode.RESOURCE_NOT_FOUND, { detail: `No route for ${req.method} ${req.path}` }));
}

export function createErrorHandler(logger: Logger) {
  return function errorHandler(
    error: unknown,
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    if (res.headersSent) {
      next(error);
      return;
    }

    let appError: AppError;
    if (AppError.isAppError(error)) {
      appError = error;
    } else if (isDuplicateKeyError(error)) {
      appError = new AppError(ErrorCode.RESOURCE_CONFLICT, {
        detail: 'A resource with these values already exists',
        cause: error,
      });
    } else {
      appError = new AppError(ErrorCode.SYSTEM_INTERNAL_ERROR, {
        detail: error instanceof Error ? error.message : 'Unknown error',
        cause: error,
      });
    }

    const requestId = getContext()?.requestId ?? 'unknown';
    const logPayload = {
      err: error,
      code: appError.code,
      status: appError.status,
      method: req.method,
      path: req.path,
      // ADR-0029: the client may be told 404 while the log records the real reason.
      ...(appError.internalReason !== undefined ? { internalReason: appError.internalReason } : {}),
    };

    if (appError.status >= 500) logger.error(logPayload, 'request failed');
    else if (appError.status === 403 || appError.status === 401) logger.warn(logPayload, 'request denied');
    else logger.info(logPayload, 'request rejected');

    res.status(appError.status).json({
      type: `${DOCS_BASE}/${appError.code}`,
      title: appError.title,
      status: appError.status,
      code: appError.code,
      // Internal messages are never leaked in production; the requestId is the way back in.
      ...(appError.status < 500 || !isProduction ? { detail: appError.detail } : {}),
      instance: req.originalUrl,
      requestId,
      ...(appError.errors ? { errors: appError.errors } : {}),
      ...(appError.params ? { params: appError.params } : {}),
      ...(appError.extra ?? {}),
    });
  };
}
