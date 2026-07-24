/** Review domain events (EVENTS.md). */
export const ReviewEvents = {
  CREATED: 'review.created',
  WITHDRAWN: 'review.withdrawn',
  REPLIED: 'review.replied',
  REPORTED: 'review.reported',
  MODERATED: 'review.moderated',
  /** Consumed by the search indexer: ranking depends on it. */
  RATING_CHANGED: 'review.rating_changed',
} as const;

export type ReviewEvent = (typeof ReviewEvents)[keyof typeof ReviewEvents];
