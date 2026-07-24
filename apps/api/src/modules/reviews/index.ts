/**
 * Public surface of the reviews module (ADR-0011 rule 1).
 *
 * Nothing outside reads reviews directly: the catalogue and the search index consume the
 * aggregates this module maintains on products and shops.
 */
export {
  createReviewService,
  type ReviewService,
  type OrderLookup,
  type ReviewableOrder,
} from './services/review.service.js';
export { createReviewController, type ReviewController } from './http/review.controller.js';
export {
  createPublicReviewRouter,
  createReviewRouter,
  createReviewAdminRouter,
} from './http/review.routes.js';
export { ratingAggregation } from './services/ratingAggregation.service.js';
export { ReviewStatus, ReportReason, REVIEW_WINDOW_DAYS, COUNTED_STATUSES } from './reviews.constants.js';
export { ReviewEvents } from './events.js';
