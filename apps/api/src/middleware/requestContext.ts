import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { runWithContext, type RequestContext } from '@bozorlar/logger';
import { DEFAULT_LOCALE, LOCALES, type Locale } from '@bozorlar/types';

const UUID_PATTERN = /^[0-9a-f-]{8,64}$/i;

function resolveLocale(header: string | undefined): Locale {
  if (!header) return DEFAULT_LOCALE;
  for (const part of header.split(',')) {
    const tag = part.split(';')[0]?.trim();
    if (tag && (LOCALES as readonly string[]).includes(tag)) return tag as Locale;
  }
  return DEFAULT_LOCALE;
}

/**
 * Establishes the correlation context for the whole request. Everything downstream — logs,
 * queue jobs, provider calls — inherits requestId and traceId from here (OBSERVABILITY.md).
 */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  // An inbound id is only trusted if it looks like one; otherwise a caller could poison logs.
  const requestId = incoming && UUID_PATTERN.test(incoming) ? incoming : randomUUID();

  const context: RequestContext = {
    requestId,
    traceId: requestId,
    ip: req.ip ?? 'unknown',
    userAgent: req.header('user-agent') ?? 'unknown',
    locale: resolveLocale(req.header('accept-language')),
  };

  res.setHeader('X-Request-Id', requestId);
  res.setHeader('Content-Language', context.locale ?? DEFAULT_LOCALE);
  req.locale = (context.locale as Locale | undefined) ?? DEFAULT_LOCALE;
  req.requestId = requestId;

  runWithContext(context, () => next());
}
