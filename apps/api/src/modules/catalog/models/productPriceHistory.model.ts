import { Schema, model, type Model, type Types } from 'mongoose';

/**
 * Price history as a time-series collection (ADR-0027).
 *
 * Append-only, never updated, always queried by time range — the exact shape time-series
 * collections exist for, at roughly a third of the storage. It powers the price chart on the
 * product page and, more importantly, makes the inflate-then-discount pattern visible before
 * buyers notice it (PRODUCT_SYSTEM.md).
 */
export interface ProductPriceHistoryDoc {
  _id: Types.ObjectId;
  changedAt: Date;
  meta: { productId: Types.ObjectId; shopId: Types.ObjectId };
  price: bigint;
  previousPrice: bigint | null;
  changedBy: Types.ObjectId | null;
}

const priceHistorySchema = new Schema<ProductPriceHistoryDoc>(
  {
    changedAt: { type: Date, required: true, default: () => new Date() },
    meta: {
      productId: { type: Schema.Types.ObjectId, required: true },
      shopId: { type: Schema.Types.ObjectId, required: true },
    },
    price: { type: BigInt, required: true },
    previousPrice: { type: BigInt, default: null },
    changedBy: { type: Schema.Types.ObjectId, default: null },
  },
  {
    collection: 'product_price_history',
    strict: 'throw',
    timeseries: { timeField: 'changedAt', metaField: 'meta', granularity: 'hours' },
    // Two years: long enough for seasonal comparison, short enough to stay cheap.
    expireAfterSeconds: 60 * 60 * 24 * 730,
    timestamps: false,
    versionKey: false,
  },
);

export const ProductPriceHistoryModel: Model<ProductPriceHistoryDoc> =
  model<ProductPriceHistoryDoc>('ProductPriceHistory', priceHistorySchema);
