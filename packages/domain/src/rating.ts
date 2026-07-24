/**
 * Rating aggregation (REVIEW_SYSTEM.md).
 *
 * Ratings are integers scaled by 100 — 4.5 stars is 450 — for the same reason money is: a
 * float average of a few thousand reviews drifts, and a shop's rating is the number that
 * decides whether anyone visits it.
 *
 * Shared because three places read it: the catalogue sorts by it, the search index ranks by
 * it, and the reviews module writes it.
 */

export const RATING_MIN = 1;
export const RATING_MAX = 5;
export const RATING_SCALE = 100;

/**
 * Prior for the Bayesian average.
 *
 * A new stall with one five-star review from a friend must not outrank a seller with four
 * hundred reviews at 4.8. The prior says "assume 20 reviews at 4.00 before we knew anything",
 * so a single rating moves the score a little and four hundred move it a lot.
 */
export const RATING_PRIOR_COUNT = 20;
export const RATING_PRIOR_VALUE = 400;

export interface RatingAggregate {
  /** Sum of every published rating, each scaled by 100. */
  sumScaled: number;
  count: number;
}

export interface RatingResult {
  /** Plain arithmetic mean, scaled by 100. What is displayed. */
  avgScaled: number;
  /** Prior-damped mean, scaled by 100. What things are sorted by. */
  bayesianScaled: number;
  count: number;
}

export function computeRating(aggregate: RatingAggregate): RatingResult {
  if (aggregate.count <= 0) {
    // No reviews is not zero stars. Sorting uses the prior, so an unrated stall sits mid-table
    // rather than last — it has not earned a bad position, only an unknown one.
    return { avgScaled: 0, bayesianScaled: RATING_PRIOR_VALUE, count: 0 };
  }
  const avgScaled = Math.round(aggregate.sumScaled / aggregate.count);
  const bayesianScaled = Math.round(
    (RATING_PRIOR_VALUE * RATING_PRIOR_COUNT + aggregate.sumScaled) /
      (RATING_PRIOR_COUNT + aggregate.count),
  );
  return { avgScaled, bayesianScaled, count: aggregate.count };
}

/** Validates a star rating as a user submits it, before it is scaled. */
export function isValidRating(stars: number): boolean {
  return Number.isInteger(stars) && stars >= RATING_MIN && stars <= RATING_MAX;
}

export function toScaled(stars: number): number {
  return stars * RATING_SCALE;
}

export function fromScaled(scaled: number): number {
  return scaled / RATING_SCALE;
}
