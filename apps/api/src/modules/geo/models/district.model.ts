import { Schema, model, type Model, type Types } from 'mongoose';
import type { LocalizedText } from '@bozorlar/types';
import { pointSchema } from './region.model.js';

export interface DistrictDoc {
  _id: Types.ObjectId;
  regionId: Types.ObjectId;
  code: string;
  name: LocalizedText;
  /**
   * Populated only where an authoritative coordinate is known. Markets carry their own
   * precise location, which is what `/markets/nearby` uses, so a null here degrades nothing
   * beyond default map framing. Left null rather than filled with an invented value.
   */
  center: { type: 'Point'; coordinates: [number, number] } | null;
  /** District-level cities (shahar) are administered separately from rural districts. */
  isCity: boolean;
  order: number;
  isActive: boolean;
  marketCount: number;
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const districtSchema = new Schema<DistrictDoc>(
  {
    regionId: { type: Schema.Types.ObjectId, required: true, ref: 'Region' },
    code: { type: String, required: true, uppercase: true, trim: true, maxlength: 12 },
    name: {
      type: {
        uz: { type: String, required: true, trim: true, maxlength: 200 },
        uzCyrl: { type: String, trim: true, maxlength: 200 },
        ru: { type: String, trim: true, maxlength: 200 },
        en: { type: String, trim: true, maxlength: 200 },
      },
      required: true,
    },
    center: { type: pointSchema, default: null },
    isCity: { type: Boolean, required: true, default: false },
    order: { type: Number, required: true, default: 0 },
    isActive: { type: Boolean, required: true, default: true },
    marketCount: { type: Number, required: true, default: 0, min: 0 },
    schemaVersion: { type: Number, required: true, default: 1 },
  },
  { timestamps: true, collection: 'districts', strict: 'throw', minimize: false },
);

districtSchema.index({ code: 1 }, { unique: true });
districtSchema.index({ regionId: 1, order: 1 });

export const DistrictModel: Model<DistrictDoc> = model<DistrictDoc>('District', districtSchema);
