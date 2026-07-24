import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
  traceId: string;
  userId?: string;
  ip?: string;
  userAgent?: string;
  locale?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Attaches the authenticated user once auth middleware resolves it, so every subsequent log
 * line in the request carries it without being passed down manually.
 */
export function setContextUser(userId: string): void {
  const context = storage.getStore();
  if (context) context.userId = userId;
}
