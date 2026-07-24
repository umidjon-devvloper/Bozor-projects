import { Schema, model, type Model, type Types } from 'mongoose';
import type { LocalizedText } from '@bozorlar/types';
import { AttributeType, MAX_CATEGORY_DEPTH } from '../catalog.constants.js';

export interface CategoryAncestor {
  _id: Types.ObjectId;
  slug: string;
  name: LocalizedText;
}

export interface AttributeDefinition {
  key: string;
  type: AttributeType;
  name: LocalizedText;
  options: string[];
  required: boolean;
  order: number;
}

export interface CategoryDoc {
  _id: Types.ObjectId;
  parentId: Types.ObjectId | null;
  /**
   * Materialised path, root first. Turns "everything under Oziq-ovqat" into a single indexed
   * lookup instead of a recursive walk, and lets breadcrumbs render with no extra reads
   * (DATABASE.md 2.3).
   */
  ancestors: CategoryAncestor[];
  depth: number;
  slug: string;
  name: LocalizedText;
  description: LocalizedText | null;
  icon: string | null;
  imageKey: string | null;
  defaultUnit: string;
  allowedUnits: string[];
  defaultTolerancePercent: number;
  attributeSchema: AttributeDefinition[];
  order: number;
  isActive: boolean;
  productCount: number;
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const localized = {
  uz: { type: String, required: true, trim: true, maxlength: 200 },
  uzCyrl: { type: String, trim: true, maxlength: 200 },
  ru: { type: String, trim: true, maxlength: 200 },
  en: { type: String, trim: true, maxlength: 200 },
};

const ancestorSchema = new Schema<CategoryAncestor>(
  {
    _id: { type: Schema.Types.ObjectId, required: true },
    slug: { type: String, required: true, maxlength: 120 },
    name: { type: localized, required: true },
  },
  { _id: false },
);

const attributeSchema = new Schema<AttributeDefinition>(
  {
    key: { type: String, required: true, maxlength: 40, match: /^[a-z][a-z0-9_]*$/ },
    type: { type: String, enum: Object.values(AttributeType), required: true },
    name: { type: localized, required: true },
    options: { type: [String], default: [] },
    required: { type: Boolean, required: true, default: false },
    order: { type: Number, required: true, default: 0 },
  },
  { _id: false },
);

const categorySchema = new Schema<CategoryDoc>(
  {
    parentId: { type: Schema.Types.ObjectId, default: null, ref: 'Category' },
    ancestors: {
      type: [ancestorSchema],
      default: [],
      validate: {
        validator: (v: CategoryAncestor[]) => v.length < MAX_CATEGORY_DEPTH,
        message: `Categories may nest at most ${MAX_CATEGORY_DEPTH} levels`,
      },
    },
    depth: { type: Number, required: true, min: 0, max: MAX_CATEGORY_DEPTH - 1, default: 0 },
    slug: { type: String, required: true, lowercase: true, trim: true, maxlength: 120 },
    name: { type: localized, required: true },
    description: { type: localized, default: null },
    icon: { type: String, default: null, maxlength: 64 },
    imageKey: { type: String, default: null, maxlength: 256 },
    defaultUnit: { type: String, required: true, maxlength: 16 },
    allowedUnits: {
      type: [String],
      required: true,
      validate: { validator: (v: string[]) => v.length > 0, message: 'At least one unit' },
    },
    defaultTolerancePercent: { type: Number, required: true, min: 0, max: 5000, default: 1000 },
    attributeSchema: { type: [attributeSchema], default: [] },
    order: { type: Number, required: true, default: 0 },
    isActive: { type: Boolean, required: true, default: true },
    productCount: { type: Number, required: true, default: 0, min: 0 },
    schemaVersion: { type: Number, required: true, default: 1 },
  },
  { timestamps: true, collection: 'categories', strict: 'throw', minimize: false },
);

categorySchema.index({ slug: 1 }, { unique: true });
categorySchema.index({ parentId: 1, order: 1 });
// The subtree query: every descendant of a category in one indexed lookup.
categorySchema.index({ 'ancestors._id': 1, isActive: 1 });
categorySchema.index({ isActive: 1, depth: 1, order: 1 });

categorySchema.pre('validate', function enforceInvariants(next) {
  if (this.depth !== this.ancestors.length) {
    next(new Error('depth must equal the number of ancestors'));
    return;
  }
  if (!this.allowedUnits.includes(this.defaultUnit)) {
    next(new Error('defaultUnit must be one of allowedUnits'));
    return;
  }
  const keys = this.attributeSchema.map((attribute) => attribute.key);
  if (new Set(keys).size !== keys.length) {
    next(new Error('attributeSchema keys must be unique'));
    return;
  }
  for (const attribute of this.attributeSchema) {
    if (attribute.type === AttributeType.ENUM && attribute.options.length === 0) {
      next(new Error(`Attribute "${attribute.key}" is an ENUM and needs options`));
      return;
    }
  }
  next();
});

export const CategoryModel: Model<CategoryDoc> = model<CategoryDoc>('Category', categorySchema);
