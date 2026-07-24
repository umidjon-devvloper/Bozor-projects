/**
 * Favourites policy (FAVORITES_SYSTEM.md).
 *
 * Shared, because the API writes favourites and the worker reads them to decide who to alert.
 * Two copies of the alert thresholds would eventually disagree about what counts as a price
 * drop, and the disagreement would only be visible as users receiving alerts the product page
 * does not corroborate.
 */

export const FavouriteTarget = {
  PRODUCT: 'PRODUCT',
  SHOP: 'SHOP',
} as const;
export type FavouriteTarget = (typeof FavouriteTarget)[keyof typeof FavouriteTarget];

export const AlertKind = {
  RESTOCK: 'RESTOCK',
  PRICE_DROP: 'PRICE_DROP',
} as const;
export type AlertKind = (typeof AlertKind)[keyof typeof AlertKind];

/**
 * How far a price must fall before it is worth interrupting somebody: 5%.
 *
 * Bazaar prices move daily and often by a few hundred som. Alerting on every movement would
 * train people to ignore the alert, which costs more than the alerts are worth.
 */
export const PRICE_DROP_MIN_BP = 500;

/**
 * And at least this much in absolute terms — 1 000 som, in tiyin.
 *
 * Five percent of a cheap bunch of herbs is small change; the percentage floor alone would
 * fire on movements nobody would cross the street for.
 */
export const PRICE_DROP_MIN_MINOR = 100_000n;

/**
 * One price alert per favourite per day, and one restock alert per favourite per day.
 *
 * A seller who edits a price repeatedly, or stock that flickers as reservations expire and
 * re-open, must not translate into a stream of notifications. The cooldown is the backstop
 * for both, independent of the watermark logic.
 */
export const PRICE_ALERT_COOLDOWN_HOURS = 24;
export const RESTOCK_ALERT_COOLDOWN_HOURS = 24;

/**
 * A ceiling on how many people one product may alert in a single fan-out pass.
 *
 * Not a product rule — a protection for the worker. A popular product favourited by tens of
 * thousands should not turn one price edit into one unbounded transaction; the pass is
 * batched and resumes from a cursor.
 */
export const ALERT_FANOUT_BATCH_SIZE = 500;

/** A person may follow this many products. High enough never to be met honestly. */
export const MAX_FAVOURITES_PER_USER = 2000;
