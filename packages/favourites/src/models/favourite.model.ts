import { Schema, model, type Model, type Types } from 'mongoose';
import { FavouriteTarget } from '../constants.js';

/**
 * One person following one thing.
 *
 * Products and shops share a collection with a discriminator rather than living in two, for
 * one reason worth stating: every read a client makes is "what does this user follow", and a
 * single collection answers it with one index rather than two queries the client must merge.
 * The alert state below is populated only for `PRODUCT` rows; a shop has nothing to restock.
 *
 * Money is Int64 tiyin here as everywhere (ADR-0004). The watermark is a price, and a price
 * stored as a Double is a price that drifts.
 */
export interface FavouriteDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  targetType: FavouriteTarget;
  targetId: Types.ObjectId;
  /** Denormalised so a fan-out can scope by shop without joining products. */
  shopId: Types.ObjectId | null;

  priceWatermarkMinor: bigint | null;
  wasPurchasable: boolean;
  lastPriceAlertAt: Date | null;
  lastRestockAlertAt: Date | null;

  /** Per-favourite opt-out. The global switch lives in notification preferences. */
  alertsEnabled: boolean;

  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const favouriteSchema = new Schema<FavouriteDoc>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    targetType: { type: String, enum: Object.values(FavouriteTarget), required: true },
    targetId: { type: Schema.Types.ObjectId, required: true },
    shopId: { type: Schema.Types.ObjectId, default: null, ref: 'Shop' },

    priceWatermarkMinor: { type: BigInt, default: null },
    wasPurchasable: { type: Boolean, required: true, default: false },
    lastPriceAlertAt: { type: Date, default: null },
    lastRestockAlertAt: { type: Date, default: null },

    alertsEnabled: { type: Boolean, required: true, default: true },

    schemaVersion: { type: Number, required: true, default: 1 },
  },
  { timestamps: true, collection: 'favourites', strict: 'throw', minimize: false },
);

// Following the same thing twice is not a second following. This index is also what makes
// `add` idempotent: a repeated tap on the heart is an upsert, not a duplicate row.
favouriteSchema.index({ userId: 1, targetType: 1, targetId: 1 }, { unique: true });
// The buyer's own list, newest first.
favouriteSchema.index({ userId: 1, targetType: 1, createdAt: -1 });
// The fan-out: everyone following this product, filtered to those still wanting alerts.
favouriteSchema.index(
  { targetId: 1, targetType: 1, _id: 1 },
  { partialFilterExpression: { alertsEnabled: true } },
);
// A seller asking how many people are waiting for a restock, and the shop-wide fan-out when a
// seller is reactivated.
favouriteSchema.index(
  { shopId: 1, targetType: 1 },
  { partialFilterExpression: { shopId: { $type: 'objectId' } } },
);

favouriteSchema.pre('validate', function enforceInvariants(next) {
  if (this.targetType === FavouriteTarget.SHOP && this.priceWatermarkMinor !== null) {
    next(new Error('A shop favourite carries no price watermark'));
    return;
  }
  next();
});

export const FavouriteModel: Model<FavouriteDoc> = model<FavouriteDoc>(
  'Favourite',
  favouriteSchema,
);
