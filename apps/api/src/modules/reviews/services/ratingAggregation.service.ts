import mongoose, { type ClientSession } from 'mongoose';
import { RATING_PRIOR_COUNT, RATING_PRIOR_VALUE, RATING_SCALE } from '@bozorlar/domain';

/**
 * Maintains the rating aggregates on products and shops.
 *
 * Done as a single aggregation-pipeline update rather than read-modify-write. Two buyers
 * reviewing the same product at the same instant would otherwise race: both read the old
 * average, both write their own, and one review vanishes from the score while remaining
 * visible in the list — a discrepancy nobody would notice until a seller counted.
 *
 * The pipeline increments the exact sum and count, then derives both averages from them in
 * the same atomic operation. The stored `ratingSum` is what makes that possible.
 */
function ratingPipeline(deltaSumScaled: number, deltaCount: number): Record<string, unknown>[] {
  return [
    {
      $set: {
        ratingSum: { $max: [0, { $add: [{ $ifNull: ['$ratingSum', 0] }, deltaSumScaled] }] },
        ratingCount: { $max: [0, { $add: [{ $ifNull: ['$ratingCount', 0] }, deltaCount] }] },
      },
    },
    {
      $set: {
        // Displayed average: the plain mean, or zero when there is nothing to average.
        ratingAvg: {
          $cond: [
            { $gt: ['$ratingCount', 0] },
            { $round: [{ $divide: ['$ratingSum', '$ratingCount'] }, 0] },
            0,
          ],
        },
        // Sort key: prior-damped, so one enthusiastic review cannot outrank four hundred.
        ratingBayesian: {
          $round: [
            {
              $divide: [
                { $add: [RATING_PRIOR_VALUE * RATING_PRIOR_COUNT, '$ratingSum'] },
                { $add: [RATING_PRIOR_COUNT, '$ratingCount'] },
              ],
            },
            0,
          ],
        },
      },
    },
  ];
}

export interface RatingDelta {
  productId: string;
  shopId: string;
  /** Stars added, unscaled. Negative when a review is withdrawn or hidden. */
  ratingDelta: number;
  countDelta: number;
}

export const ratingAggregation = {
  /**
   * Applies one review's effect to both the product and its shop.
   *
   * A shop's score is the aggregate of its products' reviews rather than a separate corpus, so
   * the two can never disagree about the same seller.
   */
  async apply(delta: RatingDelta, session: ClientSession): Promise<void> {
    const pipeline = ratingPipeline(delta.ratingDelta * RATING_SCALE, delta.countDelta);
    await mongoose.connection
      .collection('products')
      .updateOne({ _id: new mongoose.Types.ObjectId(delta.productId) }, pipeline, { session });
    await mongoose.connection
      .collection('shops')
      .updateOne({ _id: new mongoose.Types.ObjectId(delta.shopId) }, pipeline, { session });
  },

  /**
   * Recomputes an aggregate from the reviews themselves.
   *
   * The incremental path is exact, so this exists to prove it: any divergence means a write
   * escaped its transaction. Used by the reconciliation endpoint, not the hot path.
   */
  async recompute(target: { type: 'product' | 'shop'; id: string }): Promise<{
    sumScaled: number;
    count: number;
  }> {
    const field = target.type === 'product' ? 'productId' : 'shopId';
    const result = await mongoose.connection
      .collection('reviews')
      .aggregate<{ sum: number; count: number }>([
        {
          $match: {
            [field]: new mongoose.Types.ObjectId(target.id),
            status: { $in: ['PUBLISHED', 'REPORTED'] },
          },
        },
        { $group: { _id: null, sum: { $sum: '$rating' }, count: { $sum: 1 } } },
      ])
      .toArray();

    const row = result[0];
    return { sumScaled: (row?.sum ?? 0) * RATING_SCALE, count: row?.count ?? 0 };
  },

  /** Overwrites an aggregate with a recomputed value. Only used to repair a proven mismatch. */
  async reset(
    target: { type: 'product' | 'shop'; id: string },
    aggregate: { sumScaled: number; count: number },
  ): Promise<void> {
    const collection = target.type === 'product' ? 'products' : 'shops';
    const bayesian = Math.round(
      (RATING_PRIOR_VALUE * RATING_PRIOR_COUNT + aggregate.sumScaled) /
        (RATING_PRIOR_COUNT + aggregate.count),
    );
    await mongoose.connection.collection(collection).updateOne(
      { _id: new mongoose.Types.ObjectId(target.id) },
      {
        $set: {
          ratingSum: aggregate.sumScaled,
          ratingCount: aggregate.count,
          ratingAvg: aggregate.count > 0 ? Math.round(aggregate.sumScaled / aggregate.count) : 0,
          ratingBayesian: bayesian,
        },
      },
    );
  },
};
