/**
 * Checkout timings and limits.
 *
 * These move to the `settings` collection when the platform settings module lands
 * (CONFIG_SYSTEM.md); until then they are the documented registry defaults, declared once.
 */
export const RESERVATION_TTL_MINUTES = 15;
export const QUOTE_TTL_MINUTES = 15;
export const PICKUP_WINDOW_HOURS = 24;
export const MAX_CART_ITEMS = 100;
export const MAX_SHOPS_PER_QUOTE = 20;

export const ReservationStatus = {
  ACTIVE: 'ACTIVE',
  /** Converted into a committed stock decrement when the order was created. */
  COMMITTED: 'COMMITTED',
  /** Given back deliberately — a new quote, an abandoned checkout, a cancelled order. */
  RELEASED: 'RELEASED',
  /** Given back by the sweeper after the hold outlived its window. */
  EXPIRED: 'EXPIRED',
} as const;
export type ReservationStatus = (typeof ReservationStatus)[keyof typeof ReservationStatus];

/**
 * Why a cart line cannot be bought right now.
 *
 * Returned per line rather than as a single failure, because a buyer with twelve items and
 * one problem needs to know which one — not that "checkout failed".
 */
export const LineIssue = {
  PRODUCT_GONE: 'PRODUCT_GONE',
  PRODUCT_NOT_VISIBLE: 'PRODUCT_NOT_VISIBLE',
  SHOP_NOT_VISIBLE: 'SHOP_NOT_VISIBLE',
  OUT_OF_STOCK: 'OUT_OF_STOCK',
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  BELOW_MIN_ORDER: 'BELOW_MIN_ORDER',
  ABOVE_MAX_ORDER: 'ABOVE_MAX_ORDER',
  NOT_A_MULTIPLE_OF_STEP: 'NOT_A_MULTIPLE_OF_STEP',
  PRICE_CHANGED: 'PRICE_CHANGED',
} as const;
export type LineIssue = (typeof LineIssue)[keyof typeof LineIssue];

/** Issues that merely inform the buyer; the line can still be bought. */
export const ADVISORY_ISSUES: readonly LineIssue[] = [LineIssue.PRICE_CHANGED];
