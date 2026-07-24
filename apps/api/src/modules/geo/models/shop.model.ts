import { Schema, model, type Model, type Types } from 'mongoose';
import {
  ModerationStatus,
  ShopMemberRole,
  ShopStatus,
  type LocalizedText,
  type WorkingHoursEntry,
} from '@bozorlar/types';
import { pointSchema } from './region.model.js';
import { mediaRefSchema, workingHoursSchema, type MediaRef } from './market.model.js';

export interface ShopMember {
  userId: Types.ObjectId;
  role: ShopMemberRole;
  addedAt: Date;
  addedBy: Types.ObjectId;
}

export interface ShopDoc {
  _id: Types.ObjectId;
  ownerId: Types.ObjectId;
  marketId: Types.ObjectId;
  districtId: Types.ObjectId;
  regionId: Types.ObjectId;
  name: LocalizedText;
  slug: string;
  description: LocalizedText | null;
  logo: MediaRef | null;
  cover: MediaRef | null;
  photos: MediaRef[];
  sectionCode: string | null;
  stallNo: string | null;
  location: { type: 'Point'; coordinates: [number, number] } | null;
  contactPhone: string;
  members: ShopMember[];
  categoryIds: Types.ObjectId[];
  workingHours: WorkingHoursEntry[];
  timezone: string;
  vacationUntil: Date | null;
  status: ShopStatus;
  moderationStatus: ModerationStatus;
  moderationReason: string | null;
  /**
   * Owned by the wallet module (Phase 6) and maintained by the seller activation handlers.
   * Defaults to true; nothing mutates it until that module lands (DATABASE.md 3.3).
   */
  sellerWalletActive: boolean;
  /** Materialized composite visibility. Computed by @bozorlar/domain. */
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
  productCount: number;
  salesCount: number;
  reliabilityScore: number;
  deletedAt: Date | null;
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const localizedText = {
  uz: { type: String, required: true, trim: true, maxlength: 2000 },
  uzCyrl: { type: String, trim: true, maxlength: 2000 },
  ru: { type: String, trim: true, maxlength: 2000 },
  en: { type: String, trim: true, maxlength: 2000 },
};

const shopMemberSchema = new Schema<ShopMember>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    role: { type: String, enum: Object.values(ShopMemberRole), required: true },
    addedAt: { type: Date, required: true, default: () => new Date() },
    addedBy: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
  },
  { _id: false },
);

const shopSchema = new Schema<ShopDoc>(
  {
    ownerId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    marketId: { type: Schema.Types.ObjectId, required: true, ref: 'Market' },
    districtId: { type: Schema.Types.ObjectId, required: true, ref: 'District' },
    regionId: { type: Schema.Types.ObjectId, required: true, ref: 'Region' },
    name: { type: localizedText, required: true },
    slug: { type: String, required: true, lowercase: true, trim: true, maxlength: 140 },
    description: { type: localizedText, default: null },
    logo: { type: mediaRefSchema, default: null },
    cover: { type: mediaRefSchema, default: null },
    photos: {
      type: [mediaRefSchema],
      default: [],
      validate: { validator: (v: MediaRef[]) => v.length <= 10, message: 'At most 10 photos' },
    },
    sectionCode: { type: String, default: null, maxlength: 16 },
    stallNo: { type: String, default: null, maxlength: 16 },
    location: { type: pointSchema, default: null },
    contactPhone: { type: String, required: true, match: /^\+998\d{9}$/ },
    members: {
      type: [shopMemberSchema],
      required: true,
      validate: {
        validator: (v: ShopMember[]) => v.length > 0 && v.length <= 20,
        message: 'A shop must have between 1 and 20 members',
      },
    },
    categoryIds: {
      type: [Schema.Types.ObjectId],
      default: [],
      validate: { validator: (v: unknown[]) => v.length <= 10, message: 'At most 10 categories' },
    },
    workingHours: {
      type: [workingHoursSchema],
      required: true,
      validate: {
        validator: (v: WorkingHoursEntry[]) =>
          v.length === 7 && new Set(v.map((e) => e.weekday)).size === 7,
        message: 'workingHours must contain exactly one entry per weekday',
      },
    },
    timezone: { type: String, required: true, default: 'Asia/Tashkent', maxlength: 64 },
    vacationUntil: { type: Date, default: null },
    status: { type: String, enum: Object.values(ShopStatus), required: true, default: ShopStatus.DRAFT },
    moderationStatus: {
      type: String,
      enum: Object.values(ModerationStatus),
      required: true,
      default: ModerationStatus.PENDING,
    },
    moderationReason: { type: String, default: null, maxlength: 1000 },
    sellerWalletActive: { type: Boolean, required: true, default: true },
    isVisible: { type: Boolean, required: true, default: false },
    visibilityReason: { type: String, required: true, default: 'MODERATION_NOT_APPROVED' },
    visibilityComputedAt: { type: Date, required: true, default: () => new Date() },
    ratingAvg: { type: Number, required: true, default: 0, min: 0, max: 500 },
    ratingSum: { type: Number, required: true, default: 0, min: 0 },
    ratingCount: { type: Number, required: true, default: 0, min: 0 },
    ratingBayesian: { type: Number, required: true, default: 0, min: 0, max: 500 },
    productCount: { type: Number, required: true, default: 0, min: 0 },
    salesCount: { type: Number, required: true, default: 0, min: 0 },
    reliabilityScore: { type: Number, required: true, default: 1000, min: 0, max: 1000 },
    deletedAt: { type: Date, default: null },
    schemaVersion: { type: Number, required: true, default: 1 },
  },
  { timestamps: true, collection: 'shops', strict: 'throw', minimize: false },
);

shopSchema.index({ slug: 1 }, { unique: true });
shopSchema.index({ ownerId: 1 }, { partialFilterExpression: { deletedAt: null } });
// ESR ordering: equality on marketId and isVisible, then the sort key, then the tiebreaker.
shopSchema.index({ marketId: 1, isVisible: 1, ratingBayesian: -1, _id: -1 });
shopSchema.index({ marketId: 1, isVisible: 1, createdAt: -1, _id: -1 });
shopSchema.index({ 'members.userId': 1 });
shopSchema.index({ isVisible: 1, updatedAt: -1 });
shopSchema.index(
  { moderationStatus: 1, createdAt: 1 },
  { partialFilterExpression: { moderationStatus: ModerationStatus.PENDING } },
);
shopSchema.index({ location: '2dsphere' }, { sparse: true });

shopSchema.pre('validate', function enforceSingleOwner(next) {
  const owners = this.members.filter((member) => member.role === ShopMemberRole.OWNER);
  if (owners.length !== 1) {
    next(new Error('A shop must have exactly one member with the OWNER role'));
    return;
  }
  const owner = owners[0];
  if (!owner || !owner.userId.equals(this.ownerId)) {
    next(new Error('The OWNER member must be the shop owner'));
    return;
  }
  const ids = this.members.map((member) => member.userId.toString());
  if (new Set(ids).size !== ids.length) {
    next(new Error('members.userId must be unique within a shop'));
    return;
  }
  if (this.moderationStatus === ModerationStatus.REJECTED && !this.moderationReason) {
    next(new Error('moderationReason is required when moderationStatus is REJECTED'));
    return;
  }
  next();
});

export const ShopModel: Model<ShopDoc> = model<ShopDoc>('Shop', shopSchema);
