import { Schema, model, type Model, type Types } from 'mongoose';
import { RATING_MAX, RATING_MIN } from '@bozorlar/domain';
import {
  MAX_COMMENT_LENGTH,
  MAX_REVIEW_PHOTOS,
  MAX_SELLER_REPLY_LENGTH,
  ReportReason,
  ReviewStatus,
} from '../reviews.constants.js';

export interface ReviewPhoto {
  mediaKey: string;
  blurhash: string | null;
}

export interface ReviewReport {
  userId: Types.ObjectId;
  reason: ReportReason;
  note: string | null;
  at: Date;
}

/**
 * A review of one product, from one completed order.
 *
 * Tied to an order rather than to a product alone: a review that anybody can leave is a review
 * nobody trusts, and the order is what proves the person actually bought the thing
 * (REVIEW_SYSTEM.md).
 *
 * The shop rating is derived from the same documents rather than collected separately, so a
 * seller's score and their products' scores can never tell different stories.
 */
export interface ReviewDoc {
  _id: Types.ObjectId;
  orderId: Types.ObjectId;
  orderNo: string;
  productId: Types.ObjectId;
  shopId: Types.ObjectId;
  buyerId: Types.ObjectId;
  /** Snapshot: a buyer who later changes their name does not rewrite old reviews. */
  buyerName: string;
  /** 1–5, unscaled. Scaling to hundredths happens in the aggregate, not here. */
  rating: number;
  comment: string | null;
  photos: ReviewPhoto[];
  status: ReviewStatus;
  sellerReply: { text: string; at: Date; by: Types.ObjectId } | null;
  reports: ReviewReport[];
  moderatedBy: Types.ObjectId | null;
  moderatedAt: Date | null;
  moderationReason: string | null;
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const photoSchema = new Schema<ReviewPhoto>(
  {
    mediaKey: { type: String, required: true, maxlength: 256 },
    blurhash: { type: String, default: null, maxlength: 64 },
  },
  { _id: false },
);

const reportSchema = new Schema<ReviewReport>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    reason: { type: String, enum: Object.values(ReportReason), required: true },
    note: { type: String, default: null, maxlength: 500 },
    at: { type: Date, required: true, default: () => new Date() },
  },
  { _id: false },
);

const reviewSchema = new Schema<ReviewDoc>(
  {
    orderId: { type: Schema.Types.ObjectId, required: true, ref: 'Order' },
    orderNo: { type: String, required: true, maxlength: 32 },
    productId: { type: Schema.Types.ObjectId, required: true, ref: 'Product' },
    shopId: { type: Schema.Types.ObjectId, required: true, ref: 'Shop' },
    buyerId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    buyerName: { type: String, required: true, maxlength: 120 },
    rating: { type: Number, required: true, min: RATING_MIN, max: RATING_MAX, validate: Number.isInteger },
    comment: { type: String, default: null, maxlength: MAX_COMMENT_LENGTH },
    photos: {
      type: [photoSchema],
      default: [],
      validate: {
        validator: (v: ReviewPhoto[]) => v.length <= MAX_REVIEW_PHOTOS,
        message: `At most ${MAX_REVIEW_PHOTOS} photos`,
      },
    },
    status: {
      type: String,
      enum: Object.values(ReviewStatus),
      required: true,
      default: ReviewStatus.PUBLISHED,
    },
    sellerReply: {
      type: new Schema(
        {
          text: { type: String, required: true, maxlength: MAX_SELLER_REPLY_LENGTH },
          at: { type: Date, required: true },
          by: { type: Schema.Types.ObjectId, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
    reports: { type: [reportSchema], default: [] },
    moderatedBy: { type: Schema.Types.ObjectId, default: null },
    moderatedAt: { type: Date, default: null },
    moderationReason: { type: String, default: null, maxlength: 500 },
    schemaVersion: { type: Number, required: true, default: 1 },
  },
  { timestamps: true, collection: 'reviews', strict: 'throw', minimize: false },
);

// One review per product per order. Buying the same tomatoes twice earns two reviews; buying
// them once does not earn two.
reviewSchema.index({ orderId: 1, productId: 1 }, { unique: true });
reviewSchema.index({ productId: 1, status: 1, createdAt: -1 });
reviewSchema.index({ shopId: 1, status: 1, createdAt: -1 });
reviewSchema.index({ buyerId: 1, createdAt: -1 });
// The moderation queue, kept small by a partial index.
reviewSchema.index(
  { status: 1, createdAt: 1 },
  { partialFilterExpression: { status: ReviewStatus.REPORTED } },
);
// Reviews awaiting a seller's answer.
reviewSchema.index(
  { shopId: 1, createdAt: -1 },
  { partialFilterExpression: { sellerReply: null } },
);

reviewSchema.pre('validate', function enforceInvariants(next) {
  if (this.status === ReviewStatus.HIDDEN && !this.moderationReason) {
    next(new Error('A hidden review must record why it was hidden'));
    return;
  }
  const reporters = this.reports.map((report) => report.userId.toString());
  if (new Set(reporters).size !== reporters.length) {
    next(new Error('A user may report a review only once'));
    return;
  }
  next();
});

export const ReviewModel: Model<ReviewDoc> = model<ReviewDoc>('Review', reviewSchema);
