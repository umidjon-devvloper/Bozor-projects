import type { Response } from 'express';
import { getContext } from '@bozorlar/logger';

export interface CursorMeta {
  next: string | null;
  hasMore: boolean;
}

function baseMeta(): { requestId: string } {
  return { requestId: getContext()?.requestId ?? 'unknown' };
}

/** Every success response is an object with `data` and `meta` (API.md 1.3). */
export function sendData<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ data, meta: baseMeta() });
}

export function sendCollection<T>(
  res: Response,
  items: T[],
  cursor: CursorMeta,
  status = 200,
): void {
  res.status(status).json({ data: items, meta: { ...baseMeta(), cursor, count: items.length } });
}

export function sendCreated<T>(res: Response, data: T, location?: string): void {
  if (location) res.setHeader('Location', location);
  sendData(res, data, 201);
}

export function sendNoContent(res: Response): void {
  res.status(204).end();
}

export function sendAccepted<T>(res: Response, data: T): void {
  sendData(res, data, 202);
}
