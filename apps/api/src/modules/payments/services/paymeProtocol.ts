import { timingSafeEqual } from 'node:crypto';
import {
  PAYME_TIMEOUT_MS,
  PaymeCancelReason,
  PaymeError,
  PaymeState,
} from '../payments.constants.js';

/**
 * Payme's Merchant API, as decisions.
 *
 * Pure, for the same reason the Click signature is: this is where the protocol is either
 * obeyed or not, and Payme's sandbox tests exactly these transitions. The rule that shapes
 * everything here is one line from their documentation — *a repeated call to CreateTransaction,
 * PerformTransaction or CancelTransaction must return the same response as the first* — and
 * they say plainly that every request is sent twice on purpose.
 *
 * That makes idempotency the protocol rather than a nicety, and it is why none of these
 * functions decide anything from the request alone: each is a function of the request *and*
 * the transaction already stored.
 */

export interface PaymeAuthConfig {
  /** The cashbox key from the Payme dashboard. Never the merchant id. */
  key: string;
}

/**
 * `Authorization: Basic base64("Paycom:" + key)`.
 *
 * The login half is the literal string `Paycom` for every merchant; only the key varies.
 * A mismatch is -32504, not 401: Payme reads the JSON-RPC error, not the HTTP status.
 */
export function verifyPaymeAuth(header: string | undefined, config: PaymeAuthConfig): boolean {
  if (!header?.startsWith('Basic ')) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return false;
  }
  const expected = `Paycom:${config.key}`;
  const a = Buffer.from(decoded, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface StoredTransaction {
  id: string;
  providerTransactionId: string;
  amountMinor: bigint;
  state: number;
  reason: number | null;
  createdAt: Date;
  performedAt: Date | null;
  cancelledAt: Date | null;
}

export class PaymeRpcError extends Error {
  constructor(
    readonly code: number,
    readonly ru: string,
    readonly data?: string,
  ) {
    super(ru);
  }
}

/** Payme wants millisecond timestamps, and `0` rather than `null` for "has not happened". */
export function ms(date: Date | null): number {
  return date ? date.getTime() : 0;
}

/**
 * Whether a created transaction has outlived Payme's twelve-hour window.
 *
 * Checked on every touch rather than only by a sweeper: if Payme asks about a transaction we
 * have let expire, the honest answer is that it is cancelled, and answering "still created"
 * would invite them to perform it.
 */
export function hasTimedOut(transaction: StoredTransaction, now: Date): boolean {
  return (
    transaction.state === PaymeState.CREATED &&
    now.getTime() - transaction.createdAt.getTime() > PAYME_TIMEOUT_MS
  );
}

/**
 * What `CreateTransaction` should answer when a transaction with this id already exists.
 *
 * Returning the stored answer is the whole of the idempotency requirement. Creating a second
 * row would show up as a double credit the first time Payme retried, which — given they retry
 * every call by design — means the first time anybody paid.
 */
export function createResponseFor(transaction: StoredTransaction, now: Date) {
  if (hasTimedOut(transaction, now)) {
    throw new PaymeRpcError(
      PaymeError.COULD_NOT_PERFORM,
      'Время ожидания транзакции истекло',
      'transaction',
    );
  }
  if (transaction.state !== PaymeState.CREATED) {
    throw new PaymeRpcError(
      PaymeError.COULD_NOT_PERFORM,
      'Транзакция в неподходящем состоянии',
      'transaction',
    );
  }
  return {
    create_time: ms(transaction.createdAt),
    transaction: transaction.id,
    state: transaction.state,
  };
}

/**
 * `PerformTransaction` on a transaction that is already performed returns the original answer;
 * on one that is cancelled it must fail rather than quietly succeed.
 */
export function performResponseFor(transaction: StoredTransaction, now: Date) {
  if (transaction.state === PaymeState.COMPLETED) {
    return {
      transaction: transaction.id,
      perform_time: ms(transaction.performedAt),
      state: transaction.state,
    };
  }
  if (transaction.state !== PaymeState.CREATED) {
    throw new PaymeRpcError(
      PaymeError.COULD_NOT_PERFORM,
      'Транзакция отменена или недоступна',
      'transaction',
    );
  }
  if (hasTimedOut(transaction, now)) {
    throw new PaymeRpcError(
      PaymeError.COULD_NOT_PERFORM,
      'Время ожидания транзакции истекло',
      'transaction',
    );
  }
  return null; // caller must perform it
}

/**
 * Which cancelled state a transaction moves to.
 *
 * −1 and −2 are not interchangeable. −2 says the money was taken and then returned, which is
 * what Payme reconciles against and what a support engineer needs to see; collapsing both into
 * −1 would make a refunded payment indistinguishable from one that never completed.
 */
export function cancelledState(transaction: StoredTransaction): number {
  return transaction.state === PaymeState.COMPLETED
    ? PaymeState.CANCELLED_AFTER_COMPLETE
    : PaymeState.CANCELLED;
}

export function cancelResponseFor(transaction: StoredTransaction) {
  return {
    transaction: transaction.id,
    cancel_time: ms(transaction.cancelledAt),
    state: transaction.state,
  };
}

export function checkResponseFor(transaction: StoredTransaction) {
  return {
    create_time: ms(transaction.createdAt),
    perform_time: ms(transaction.performedAt),
    cancel_time: ms(transaction.cancelledAt),
    transaction: transaction.id,
    state: transaction.state,
    reason: transaction.reason,
  };
}

export { PaymeCancelReason };
