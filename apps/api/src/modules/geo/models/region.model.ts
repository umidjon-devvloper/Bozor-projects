import { Schema, model, type Model, type Types } from 'mongoose';
import type { LocalizedText } from '@bozorlar/types';

export interface RegionDoc {
  _id: Types.ObjectId;
  code: string;
  name: LocalizedText;
  center: { type: 'Point'; coordinates: [number, number] };
  order: number;
  isActive: boolean;
  districtCount: number;
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const localizedText = {
  uz: { type: String, required: true, trim: true, maxlength: 200 },
  uzCyrl: { type: String, trim: true, maxlength: 200 },
  ru: { type: String, trim: true, maxlength: 200 },
  en: { type: String, trim: true, maxlength: 200 },
};

export const pointSchema = new Schema(
  {
    type: { type: String, enum: ['Point'], required: true, default: 'Point' },
    // GeoJSON order is [longitude, latitude]. Reversing it silently places every market in
    // the wrong hemisphere, so the bounds are validated rather than trusted.
    coordinates: {
      type: [Number],
      required: true,
      validate: {
        validator: (value: number[]) =>
          value.length === 2 &&
          value[0] !== undefined && value[0] >= -180 && value[0] <= 180 &&
          value[1] !== undefined && value[1] >= -90 && value[1] <= 90,
        message: 'coordinates must be [longitude, latitude] within valid bounds',
      },
    },
  },
  { _id: false },
);

const regionSchema = new Schema<RegionDoc>(
  {
    code: { type: String, required: true, uppercase: true, trim: true, maxlength: 8 },
    name: { type: localizedText, required: true },
    center: { type: pointSchema, required: true },
    order: { type: Number, required: true, default: 0 },
    isActive: { type: Boolean, required: true, default: true },
    districtCount: { type: Number, required: true, default: 0, min: 0 },
    schemaVersion: { type: Number, required: true, default: 1 },
  },
  { timestamps: true, collection: 'regions', strict: 'throw', minimize: false },
);

regionSchema.index({ code: 1 }, { unique: true });
regionSchema.index({ order: 1 });

export const RegionModel: Model<RegionDoc> = model<RegionDoc>('Region', regionSchema);
