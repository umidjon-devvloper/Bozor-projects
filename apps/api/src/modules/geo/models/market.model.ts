import { Schema, model, type Model, type Types } from 'mongoose';
import { MarketStatus, type LocalizedText, type WorkingHoursEntry } from '@bozorlar/types';
import { pointSchema } from './region.model.js';

export interface MediaRef {
  key: string;
  width: number | null;
  height: number | null;
  blurhash: string | null;
  order: number;
}

export interface MarketDoc {
  _id: Types.ObjectId;
  districtId: Types.ObjectId;
  /** Denormalized from the district: enables region filtering without a join (DATABASE.md 3.3). */
  regionId: Types.ObjectId;
  name: LocalizedText;
  slug: string;
  description: LocalizedText | null;
  location: { type: 'Point'; coordinates: [number, number] };
  address: LocalizedText;
  photos: MediaRef[];
  workingHours: WorkingHoursEntry[];
  timezone: string;
  contactPhone: string | null;
  status: MarketStatus;
  shopCount: number;
  productCount: number;
  sections: Array<{ code: string; name: LocalizedText }>;
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

export const mediaRefSchema = new Schema<MediaRef>(
  {
    key: { type: String, required: true, maxlength: 256 },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    blurhash: { type: String, default: null, maxlength: 64 },
    order: { type: Number, required: true, default: 0 },
  },
  { _id: false },
);

export const workingHoursSchema = new Schema<WorkingHoursEntry>(
  {
    weekday: { type: Number, required: true, min: 0, max: 6 },
    opensAt: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
    closesAt: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
    isClosed: { type: Boolean, required: true, default: false },
  },
  { _id: false },
);

const marketSchema = new Schema<MarketDoc>(
  {
    districtId: { type: Schema.Types.ObjectId, required: true, ref: 'District' },
    regionId: { type: Schema.Types.ObjectId, required: true, ref: 'Region' },
    name: { type: localizedText, required: true },
    slug: { type: String, required: true, lowercase: true, trim: true, maxlength: 120 },
    description: { type: localizedText, default: null },
    location: { type: pointSchema, required: true },
    address: { type: localizedText, required: true },
    photos: {
      type: [mediaRefSchema],
      default: [],
      validate: { validator: (v: MediaRef[]) => v.length <= 10, message: 'At most 10 photos' },
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
    contactPhone: { type: String, default: null, match: /^\+998\d{9}$/ },
    status: {
      type: String,
      enum: Object.values(MarketStatus),
      required: true,
      default: MarketStatus.ACTIVE,
    },
    shopCount: { type: Number, required: true, default: 0, min: 0 },
    productCount: { type: Number, required: true, default: 0, min: 0 },
    sections: {
      type: [
        new Schema(
          { code: { type: String, required: true, maxlength: 16 }, name: { type: localizedText, required: true } },
          { _id: false },
        ),
      ],
      default: [],
      validate: { validator: (v: unknown[]) => v.length <= 100, message: 'At most 100 sections' },
    },
    schemaVersion: { type: Number, required: true, default: 1 },
  },
  { timestamps: true, collection: 'markets', strict: 'throw', minimize: false },
);

marketSchema.index({ location: '2dsphere' });
marketSchema.index({ slug: 1 }, { unique: true });
marketSchema.index({ districtId: 1, status: 1 });
marketSchema.index({ regionId: 1, status: 1 });
// ESR: equality on status, then sort on shopCount. Serves the "busiest markets" listing.
marketSchema.index({ status: 1, shopCount: -1, _id: -1 });

export const MarketModel: Model<MarketDoc> = model<MarketDoc>('Market', marketSchema);
