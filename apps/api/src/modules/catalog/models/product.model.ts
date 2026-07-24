import { Schema, model, type Model, type Types } from 'mongoose';
import type { LocalizedText } from '@bozorlar/types';
import { ModerationStatus } from '@bozorlar/types';
import {
  MAX_PRODUCT_IMAGES,
  MAX_PRODUCT_TAGS,
  ProductStatus,
} from '../catalog.constants.js';

export interface ProductImage {
  mediaKey: string;
  width: number | null;
  height: number | null;
  blurhash: string | null;
  order: number;
}

export interface ProductDoc {
  _id: Types.ObjectId;
  shopId: Types.ObjectId;
  /** Denormalised from the shop so geography filters need no join (DATABASE.md 3.3). */
  marketId: Types.ObjectId;
  districtId: Types.ObjectId;
  regionId: Types.ObjectId;
  categoryId: Types.ObjectId;
  /** Denormalised ancestor ids: one indexed lookup for a whole category subtree. */
  categoryPath: Types.ObjectId[];
  name: LocalizedText;
  description: LocalizedText | null;
  images: ProductImage[];
  unit: string;

  // Money is Int64 tiyin and quantity is Int64 milli-units, stored as BSON Long via BigInt.
  // A Double here would reintroduce exactly the drift ADR-0004 and ADR-0025 removed.
  price: bigint;
  oldPrice: bigint | null;
  stockQtyMilli: bigint;
  /** Written by the reservation module (Phase 4). Zero until then; the field is real. */
  reservedQtyMilli: bigint;
  minOrderQtyMilli: bigint;
  stepQtyMilli: bigint;
  maxOrderQtyMilli: bigint | null;
  tolerancePercent: number;

  attributes: Record<string, unknown>;
  tags: string[];
  status: ProductStatus;
  moderationStatus: ModerationStatus;
  moderationReason: string | null;
  /** Denormalised from the shop; the worker keeps it in step. */
  shopVisible: boolean;
  isVisible: boolean;
  visibilityReason: string;
  visibilityComputedAt: Date;

  ratingAvg: number;
  /**
   * Sum of every published rating, each scaled by 100.
   *
   * Stored rather than derived so that adding a review is one atomic `$inc`, with no read of
   * the previous average and therefore no race between two reviewers.
   */
  ratingSum: number;
  ratingCount: number;
  ratingBayesian: number;
  viewCount: number;
  favoriteCount: number;
  salesCount: number;
  soldQtyMilli: bigint;
  lastSoldAt: Date | null;
  publishedAt: Date | null;
  slug: string;
  deletedAt: Date | null;
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const localized = {
  uz: { type: String, required: true, trim: true, maxlength: 2000 },
  uzCyrl: { type: String, trim: true, maxlength: 2000 },
  ru: { type: String, trim: true, maxlength: 2000 },
  en: { type: String, trim: true, maxlength: 2000 },
};

const imageSchema = new Schema<ProductImage>(
  {
    mediaKey: { type: String, required: true, maxlength: 256 },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    blurhash: { type: String, default: null, maxlength: 64 },
    order: { type: Number, required: true, default: 0 },
  },
  { _id: false },
);

const productSchema = new Schema<ProductDoc>(
  {
    shopId: { type: Schema.Types.ObjectId, required: true, ref: 'Shop' },
    marketId: { type: Schema.Types.ObjectId, required: true },
    districtId: { type: Schema.Types.ObjectId, required: true },
    regionId: { type: Schema.Types.ObjectId, required: true },
    categoryId: { type: Schema.Types.ObjectId, required: true, ref: 'Category' },
    categoryPath: { type: [Schema.Types.ObjectId], required: true, default: [] },
    name: { type: localized, required: true },
    description: { type: localized, default: null },
    images: {
      type: [imageSchema],
      required: true,
      validate: {
        validator: (v: ProductImage[]) => v.length >= 1 && v.length <= MAX_PRODUCT_IMAGES,
        message: `A product needs between 1 and ${MAX_PRODUCT_IMAGES} images`,
      },
    },
    unit: { type: String, required: true, maxlength: 16 },

    price: { type: BigInt, required: true },
    oldPrice: { type: BigInt, default: null },
    stockQtyMilli: { type: BigInt, required: true },
    reservedQtyMilli: { type: BigInt, required: true, default: 0n },
    minOrderQtyMilli: { type: BigInt, required: true },
    stepQtyMilli: { type: BigInt, required: true },
    maxOrderQtyMilli: { type: BigInt, default: null },
    tolerancePercent: { type: Number, required: true, min: 0, max: 5000 },

    attributes: { type: Schema.Types.Mixed, default: {} },
    tags: {
      type: [String],
      default: [],
      validate: { validator: (v: string[]) => v.length <= MAX_PRODUCT_TAGS, message: 'Too many tags' },
    },
    status: { type: String, enum: Object.values(ProductStatus), required: true, default: ProductStatus.DRAFT },
    moderationStatus: {
      type: String,
      enum: Object.values(ModerationStatus),
      required: true,
      default: ModerationStatus.PENDING,
    },
    moderationReason: { type: String, default: null, maxlength: 1000 },
    shopVisible: { type: Boolean, required: true, default: false },
    isVisible: { type: Boolean, required: true, default: false },
    visibilityReason: { type: String, required: true, default: 'MODERATION_NOT_APPROVED' },
    visibilityComputedAt: { type: Date, required: true, default: () => new Date() },

    ratingAvg: { type: Number, required: true, default: 0, min: 0, max: 500 },
    ratingSum: { type: Number, required: true, default: 0, min: 0 },
    ratingCount: { type: Number, required: true, default: 0, min: 0 },
    ratingBayesian: { type: Number, required: true, default: 400, min: 0, max: 500 },
    viewCount: { type: Number, required: true, default: 0, min: 0 },
    favoriteCount: { type: Number, required: true, default: 0, min: 0 },
    salesCount: { type: Number, required: true, default: 0, min: 0 },
    soldQtyMilli: { type: BigInt, required: true, default: 0n },
    lastSoldAt: { type: Date, default: null },
    publishedAt: { type: Date, default: null },
    slug: { type: String, required: true, lowercase: true, maxlength: 160 },
    deletedAt: { type: Date, default: null },
    schemaVersion: { type: Number, required: true, default: 1 },
  },
  { timestamps: true, collection: 'products', strict: 'throw', minimize: false },
);

productSchema.index({ slug: 1 }, { unique: true });
// Seller dashboard.
productSchema.index({ shopId: 1, status: 1, createdAt: -1 }, { partialFilterExpression: { deletedAt: null } });
// Public shop page.
productSchema.index({ shopId: 1, isVisible: 1, createdAt: -1, _id: -1 });
// Category browse with a price filter or sort. ESR: equality, sort, range.
productSchema.index({ categoryId: 1, isVisible: 1, price: 1, _id: 1 });
// Whole-subtree browse, ranked.
productSchema.index({ categoryPath: 1, isVisible: 1, ratingBayesian: -1, _id: -1 });
// Market bestsellers.
productSchema.index({ marketId: 1, isVisible: 1, salesCount: -1, _id: -1 });
// Search indexer cursor (Phase 9) and the shop-visibility cascade.
productSchema.index({ isVisible: 1, updatedAt: -1 });
productSchema.index({ shopId: 1, deletedAt: 1 });
// Moderation queue.
productSchema.index(
  { moderationStatus: 1, createdAt: 1 },
  { partialFilterExpression: { moderationStatus: ModerationStatus.PENDING } },
);
// Restock sweeper: products that ran out and may now have stock again.
productSchema.index(
  { status: 1, stockQtyMilli: 1 },
  { partialFilterExpression: { status: ProductStatus.OUT_OF_STOCK } },
);

productSchema.pre('validate', function enforceInvariants(next) {
  if (this.price <= 0n) {
    next(new Error('price must be greater than zero'));
    return;
  }
  if (this.oldPrice !== null && this.oldPrice !== undefined && this.oldPrice <= this.price) {
    next(new Error('oldPrice must be greater than price'));
    return;
  }
  if (this.stockQtyMilli < 0n) {
    next(new Error('stockQtyMilli cannot be negative'));
    return;
  }
  if (this.reservedQtyMilli < 0n || this.reservedQtyMilli > this.stockQtyMilli) {
    next(new Error('reservedQtyMilli must be between zero and stockQtyMilli'));
    return;
  }
  if (this.minOrderQtyMilli <= 0n || this.stepQtyMilli <= 0n) {
    next(new Error('minOrderQtyMilli and stepQtyMilli must be greater than zero'));
    return;
  }
  // A minimum that is not a whole number of steps is unsatisfiable: the buyer can never
  // land exactly on it.
  if (this.minOrderQtyMilli % this.stepQtyMilli !== 0n) {
    next(new Error('minOrderQtyMilli must be a multiple of stepQtyMilli'));
    return;
  }
  if (
    this.maxOrderQtyMilli !== null &&
    this.maxOrderQtyMilli !== undefined &&
    this.maxOrderQtyMilli < this.minOrderQtyMilli
  ) {
    next(new Error('maxOrderQtyMilli must not be below minOrderQtyMilli'));
    return;
  }
  if (this.moderationStatus === ModerationStatus.REJECTED && !this.moderationReason) {
    next(new Error('moderationReason is required when a product is REJECTED'));
    return;
  }
  next();
});

export const ProductModel: Model<ProductDoc> = model<ProductDoc>('Product', productSchema);
