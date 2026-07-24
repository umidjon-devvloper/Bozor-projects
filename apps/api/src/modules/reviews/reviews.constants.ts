/**
 * Review policy (REVIEW_SYSTEM.md, MODERATION.md).
 */
export const ReviewStatus = {
  /** Live and counted in the aggregate. */
  PUBLISHED: 'PUBLISHED',
  /** Flagged by someone and awaiting a moderator; still counted until a decision. */
  REPORTED: 'REPORTED',
  /** Removed by a moderator. Excluded from the aggregate. */
  HIDDEN: 'HIDDEN',
  /** Withdrawn by its author. Excluded from the aggregate. */
  WITHDRAWN: 'WITHDRAWN',
} as const;
export type ReviewStatus = (typeof ReviewStatus)[keyof typeof ReviewStatus];

/** Statuses whose ratings count toward a product's or shop's score. */
export const COUNTED_STATUSES: readonly ReviewStatus[] = [
  ReviewStatus.PUBLISHED,
  ReviewStatus.REPORTED,
];

export const ReportReason = {
  OFFENSIVE: 'OFFENSIVE',
  SPAM: 'SPAM',
  IRRELEVANT: 'IRRELEVANT',
  PERSONAL_DATA: 'PERSONAL_DATA',
  FAKE: 'FAKE',
  OTHER: 'OTHER',
} as const;
export type ReportReason = (typeof ReportReason)[keyof typeof ReportReason];

/**
 * How long after collecting an order a buyer may review it.
 *
 * Long enough that somebody who bought vegetables on Saturday can still say what they thought
 * on Monday; short enough that a review is about a purchase the seller can still remember.
 */
export const REVIEW_WINDOW_DAYS = 30;

/** A seller may answer once. A thread of replies is a conversation, not a review. */
export const MAX_SELLER_REPLY_LENGTH = 1000;
export const MAX_COMMENT_LENGTH = 2000;
export const MAX_REVIEW_PHOTOS = 5;
/** Reports needed before a review is pulled into the moderation queue automatically. */
export const AUTO_REPORT_THRESHOLD = 3;
