/** Reporting policy. */

/**
 * The longest window a single report may cover.
 *
 * Not an arbitrary limit. Every figure here is computed by scanning the period rather than
 * read from a rollup, so the range *is* the cost of the query. A year and a day is enough for
 * any statement or year-on-year comparison anyone actually asks for, and it keeps the worst
 * case bounded while the rollup collection does not exist yet.
 */
export const MAX_REPORT_DAYS = 366;

/** Sellers per page in the platform leaderboard. */
export const SELLER_REPORT_PAGE_SIZE = 50;

/**
 * Queue entries older than this are called out separately.
 *
 * A moderation queue with ten items is not interesting; a queue with one item that has been
 * waiting five days is. The report surfaces the second because that is the one somebody has
 * to act on.
 */
export const QUEUE_STALE_HOURS = 48;
