import { describe, expect, it } from 'vitest';
import {
  computeRating,
  fromScaled,
  isValidRating,
  toScaled,
  RATING_PRIOR_COUNT,
  RATING_PRIOR_VALUE,
} from '@bozorlar/domain';
import {
  COUNTED_STATUSES,
  REVIEW_WINDOW_DAYS,
  ReviewStatus,
} from '../../src/modules/reviews/reviews.constants.js';
import { ReviewStatusSchema } from '@bozorlar/contracts';

describe('rating aggregation', () => {
  it('averages exactly, with no float drift', () => {
    // Three reviews of 4, 5 and 5 average to 4.666… — stored as 467 hundredths.
    expect(computeRating({ sumScaled: 400 + 500 + 500, count: 3 }).avgScaled).toBe(467);
  });

  it('treats no reviews as unknown, not as zero stars', () => {
    const result = computeRating({ sumScaled: 0, count: 0 });
    expect(result.avgScaled).toBe(0);
    // Sorting uses the prior, so an unrated stall sits mid-table rather than last: it has not
    // earned a bad position, only an unknown one.
    expect(result.bayesianScaled).toBe(RATING_PRIOR_VALUE);
  });

  it('stops one enthusiastic review outranking four hundred', () => {
    const newcomer = computeRating({ sumScaled: 500, count: 1 });
    const established = computeRating({ sumScaled: 480 * 400, count: 400 });
    expect(newcomer.avgScaled).toBeGreaterThan(established.avgScaled);
    // The displayed average favours the newcomer; the sort key does not.
    expect(newcomer.bayesianScaled).toBeLessThan(established.bayesianScaled);
  });

  it('converges on the true average as reviews accumulate', () => {
    const few = computeRating({ sumScaled: 500 * 5, count: 5 });
    const many = computeRating({ sumScaled: 500 * 500, count: 500 });
    expect(many.bayesianScaled).toBeGreaterThan(few.bayesianScaled);
    expect(many.bayesianScaled).toBeGreaterThan(490);
  });

  it('damps a bad newcomer as much as a good one', () => {
    const harsh = computeRating({ sumScaled: 100, count: 1 });
    expect(harsh.avgScaled).toBe(100);
    // A single one-star review must not sink a stall to the bottom either.
    expect(harsh.bayesianScaled).toBeGreaterThan(300);
  });

  it('uses a prior large enough to matter and small enough to escape', () => {
    expect(RATING_PRIOR_COUNT).toBeGreaterThan(5);
    expect(RATING_PRIOR_COUNT).toBeLessThan(100);
  });

  it('round-trips the scale', () => {
    expect(toScaled(4)).toBe(400);
    expect(fromScaled(450)).toBe(4.5);
  });
});

describe('rating validation', () => {
  it('accepts whole stars only', () => {
    for (const stars of [1, 2, 3, 4, 5]) expect(isValidRating(stars)).toBe(true);
    for (const bad of [0, 6, 4.5, -1, Number.NaN]) expect(isValidRating(bad), String(bad)).toBe(false);
  });
});

describe('review policy', () => {
  it('counts a reported review until a moderator decides', () => {
    // Removing a score on an accusation alone would make reporting a way to attack a
    // competitor's rating.
    expect(COUNTED_STATUSES).toContain(ReviewStatus.REPORTED);
  });

  it('excludes hidden and withdrawn reviews from the score', () => {
    expect(COUNTED_STATUSES).not.toContain(ReviewStatus.HIDDEN);
    expect(COUNTED_STATUSES).not.toContain(ReviewStatus.WITHDRAWN);
  });

  it('closes the window while a seller can still remember the purchase', () => {
    expect(REVIEW_WINDOW_DAYS).toBeGreaterThan(7);
    expect(REVIEW_WINDOW_DAYS).toBeLessThanOrEqual(90);
  });

  it('keeps the wire enum and the server enum in step', () => {
    expect([...ReviewStatusSchema.options].sort()).toEqual(Object.values(ReviewStatus).sort());
  });
});

describe('aggregate arithmetic under mutation', () => {
  /** Mirrors the pipeline update: sum and count move, the averages are derived. */
  const apply = (state: { sumScaled: number; count: number }, ratingDelta: number, countDelta: number) => ({
    sumScaled: Math.max(0, state.sumScaled + ratingDelta * 100),
    count: Math.max(0, state.count + countDelta),
  });

  it('returns to its starting point when a review is withdrawn', () => {
    let state = { sumScaled: 0, count: 0 };
    state = apply(state, 5, 1);
    state = apply(state, 4, 1);
    expect(computeRating(state).avgScaled).toBe(450);

    state = apply(state, -4, -1);
    expect(computeRating(state).avgScaled).toBe(500);
    state = apply(state, -5, -1);
    expect(computeRating(state)).toEqual({ avgScaled: 0, bayesianScaled: RATING_PRIOR_VALUE, count: 0 });
  });

  it('is order-independent, which is what makes concurrent reviews safe', () => {
    const forwards = [5, 3, 4, 1].reduce((state, r) => apply(state, r, 1), { sumScaled: 0, count: 0 });
    const backwards = [1, 4, 3, 5].reduce((state, r) => apply(state, r, 1), { sumScaled: 0, count: 0 });
    expect(computeRating(forwards)).toEqual(computeRating(backwards));
  });

  it('cannot be driven negative by a double retraction', () => {
    // The pipeline clamps at zero, so a redelivered withdrawal cannot corrupt the score.
    let state = { sumScaled: 500, count: 1 };
    state = apply(state, -5, -1);
    state = apply(state, -5, -1);
    expect(state).toEqual({ sumScaled: 0, count: 0 });
  });
});
