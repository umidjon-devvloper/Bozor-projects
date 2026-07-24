import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError, ErrorCode } from '@bozorlar/errors';
import { env } from '@bozorlar/config';

export interface CursorPayload {
  /** Cursor format version, so the encoding can change without breaking live clients. */
  v: 1;
  /** The sort expression the cursor was issued for. */
  s: string;
  /** Sort-key tuple of the last returned row, ending with _id as the tiebreaker. */
  k: (string | number | null)[];
}

const SECRET = env.PII_ENCRYPTION_KEY;

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(body).digest('base64url').slice(0, 22);
}

/**
 * Cursors are signed. An unsigned cursor is an open invitation to send an arbitrary sort key
 * and force an unindexed scan; a tampered one should be rejected, not executed (API.md 1.6).
 */
export function encodeCursor(payload: CursorPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

export function decodeCursor(cursor: string, expectedSort: string): CursorPayload {
  const [body, signature] = cursor.split('.');
  if (!body || !signature) {
    throw new AppError(ErrorCode.PAGINATION_INVALID_CURSOR, { detail: 'Malformed cursor' });
  }
  const expected = sign(body);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AppError(ErrorCode.PAGINATION_INVALID_CURSOR, { detail: 'Cursor signature invalid' });
  }

  let payload: CursorPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as CursorPayload;
  } catch {
    throw new AppError(ErrorCode.PAGINATION_INVALID_CURSOR, { detail: 'Cursor is not valid JSON' });
  }

  if (payload.v !== 1) {
    throw new AppError(ErrorCode.PAGINATION_INVALID_CURSOR, { detail: 'Unsupported cursor version' });
  }
  // Changing sort or filter mid-pagination cannot produce a coherent page, so it is rejected
  // rather than silently returning wrong results.
  if (payload.s !== expectedSort) {
    throw new AppError(ErrorCode.PAGINATION_CURSOR_MISMATCH, {
      detail: `Cursor was issued for sort "${payload.s}" but "${expectedSort}" was requested`,
    });
  }
  return payload;
}
