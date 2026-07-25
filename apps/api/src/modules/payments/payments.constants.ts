/**
 * Payment provider constants.
 *
 * Every value here is transcribed from the providers' own reference implementations —
 * PaycomUZ/paycom-integration-php-template and click-llc/click-integration-php — rather than
 * from memory or from a blog post. Where a number is a protocol constant it is named and
 * commented, because a wrong constant in a payment integration does not fail loudly: it fails
 * as a payment that was taken and not credited.
 */

export const PaymentProvider = {
  PAYME: 'PAYME',
  CLICK: 'CLICK',
} as const;
export type PaymentProvider = (typeof PaymentProvider)[keyof typeof PaymentProvider];

/** What the money is for. Only wallet top-ups exist today; see PAYMENTS.md. */
export const PaymentPurpose = {
  SELLER_TOPUP: 'SELLER_TOPUP',
} as const;
export type PaymentPurpose = (typeof PaymentPurpose)[keyof typeof PaymentPurpose];

/**
 * Payme transaction states, as Payme defines them.
 *
 * Not our vocabulary and deliberately not renamed: these integers go out on the wire in every
 * CheckTransaction response, and a local alias would be one translation layer between us and
 * the thing a support engineer reads off Payme's dashboard.
 */
export const PaymeState = {
  CREATED: 1,
  COMPLETED: 2,
  CANCELLED: -1,
  CANCELLED_AFTER_COMPLETE: -2,
} as const;
export type PaymeState = (typeof PaymeState)[keyof typeof PaymeState];

/** Payme cancellation reasons. 4 is the one we raise ourselves, on timeout. */
export const PaymeCancelReason = {
  RECEIVERS_NOT_FOUND: 1,
  PROCESSING_EXECUTION_FAILED: 2,
  EXECUTION_FAILED: 3,
  CANCELLED_BY_TIMEOUT: 4,
  FUND_RETURNED: 5,
  UNKNOWN: 10,
} as const;

/**
 * Payme JSON-RPC error codes.
 *
 * The -31050..-31099 band is reserved for "the account in this request means nothing to you",
 * and the merchant chooses a code within it. We use the first, which is what every reference
 * implementation does.
 */
export const PaymeError = {
  INTERNAL_SYSTEM: -32400,
  INSUFFICIENT_PRIVILEGE: -32504,
  INVALID_JSON_RPC: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_AMOUNT: -31001,
  TRANSACTION_NOT_FOUND: -31003,
  COULD_NOT_CANCEL: -31007,
  COULD_NOT_PERFORM: -31008,
  INVALID_ACCOUNT: -31050,
} as const;

/**
 * Twelve hours, in milliseconds, after which a created-but-unpaid Payme transaction must be
 * cancelled with reason 4. Payme's own constant, not a choice of ours.
 */
export const PAYME_TIMEOUT_MS = 43_200_000;

/**
 * Click callback error codes.
 *
 * Click's protocol is an HTTP 200 with a negative `error` field rather than an HTTP status,
 * so these are the whole of the failure vocabulary. Returning the wrong one makes Click retry
 * something it should abandon, or abandon something it should retry.
 */
export const ClickError = {
  SUCCESS: 0,
  SIGN_CHECK_FAILED: -1,
  INCORRECT_AMOUNT: -2,
  ACTION_NOT_FOUND: -3,
  ALREADY_PAID: -4,
  USER_NOT_FOUND: -5,
  TRANSACTION_NOT_FOUND: -6,
  FAILED_TO_UPDATE: -7,
  REQUEST_FROM_CLICK_FAILED: -8,
  TRANSACTION_CANCELLED: -9,
} as const;

export const ClickAction = {
  PREPARE: 0,
  COMPLETE: 1,
} as const;

/**
 * A top-up must be worth the card fee at the bottom and must look like a mistake at the top.
 * Both in tiyin.
 */
export const MIN_TOPUP_MINOR = 500_000n; // 5 000 som
export const MAX_TOPUP_MINOR = 5_000_000_000n; // 50 000 000 som
