import { Schema, model, type Model, type Types } from 'mongoose';
import type { LocalizedText } from '@bozorlar/types';

/**
 * Units of sale.
 *
 * `decimalPlaces` and `allowsAdjustment` are the two fields that make the bazaar domain work:
 * they decide whether a quantity may be fractional, and whether the handover adjustment flow
 * applies to it (ADR-0006). Beef is weighed and adjusts; eggs are counted and do not.
 */
export interface UnitDoc {
  _id: Types.ObjectId;
  code: string;
  name: LocalizedText;
  shortName: LocalizedText;
  /** 0 for countable goods, up to 3 for weighed goods. */
  decimalPlaces: number;
  allowsAdjustment: boolean;
  order: number;
  isActive: boolean;
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const localized = {
  uz: { type: String, required: true, trim: true, maxlength: 100 },
  uzCyrl: { type: String, trim: true, maxlength: 100 },
  ru: { type: String, trim: true, maxlength: 100 },
  en: { type: String, trim: true, maxlength: 100 },
};

const unitSchema = new Schema<UnitDoc>(
  {
    code: { type: String, required: true, lowercase: true, trim: true, maxlength: 16 },
    name: { type: localized, required: true },
    shortName: { type: localized, required: true },
    decimalPlaces: { type: Number, required: true, min: 0, max: 3 },
    allowsAdjustment: { type: Boolean, required: true },
    order: { type: Number, required: true, default: 0 },
    isActive: { type: Boolean, required: true, default: true },
    schemaVersion: { type: Number, required: true, default: 1 },
  },
  { timestamps: true, collection: 'units', strict: 'throw', minimize: false },
);

unitSchema.index({ code: 1 }, { unique: true });
unitSchema.index({ order: 1 });

export const UnitModel: Model<UnitDoc> = model<UnitDoc>('Unit', unitSchema);
