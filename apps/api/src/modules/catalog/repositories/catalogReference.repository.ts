import { Types } from 'mongoose';
import type { LocalizedText } from '@bozorlar/types';
import { CategoryModel, type CategoryDoc, type AttributeDefinition } from '../models/category.model.js';
import { UnitModel, type UnitDoc } from '../models/unit.model.js';

export interface UnitRecord {
  code: string;
  name: LocalizedText;
  shortName: LocalizedText;
  decimalPlaces: number;
  allowsAdjustment: boolean;
}

export interface CategoryRecord {
  id: string;
  parentId: string | null;
  ancestors: Array<{ id: string; slug: string; name: LocalizedText }>;
  depth: number;
  slug: string;
  name: LocalizedText;
  description: LocalizedText | null;
  icon: string | null;
  defaultUnit: string;
  allowedUnits: string[];
  defaultTolerancePercent: number;
  attributeSchema: AttributeDefinition[];
  order: number;
  isActive: boolean;
  productCount: number;
}

function toUnit(doc: UnitDoc): UnitRecord {
  return {
    code: doc.code,
    name: doc.name,
    shortName: doc.shortName,
    decimalPlaces: doc.decimalPlaces,
    allowsAdjustment: doc.allowsAdjustment,
  };
}

function toCategory(doc: CategoryDoc): CategoryRecord {
  return {
    id: doc._id.toString(),
    parentId: doc.parentId?.toString() ?? null,
    ancestors: doc.ancestors.map((ancestor) => ({
      id: ancestor._id.toString(),
      slug: ancestor.slug,
      name: ancestor.name,
    })),
    depth: doc.depth,
    slug: doc.slug,
    name: doc.name,
    description: doc.description,
    icon: doc.icon,
    defaultUnit: doc.defaultUnit,
    allowedUnits: doc.allowedUnits,
    defaultTolerancePercent: doc.defaultTolerancePercent,
    attributeSchema: doc.attributeSchema,
    order: doc.order,
    isActive: doc.isActive,
    productCount: doc.productCount,
  };
}

export const catalogReferenceRepository = {
  async listUnits(): Promise<UnitRecord[]> {
    const docs = await UnitModel.find({ isActive: true }).sort({ order: 1 }).lean<UnitDoc[]>();
    return docs.map(toUnit);
  },

  async findUnit(code: string): Promise<UnitRecord | null> {
    const doc = await UnitModel.findOne({ code: code.toLowerCase(), isActive: true }).lean<UnitDoc>();
    return doc ? toUnit(doc) : null;
  },

  async listCategories(): Promise<CategoryRecord[]> {
    const docs = await CategoryModel.find({ isActive: true })
      .sort({ depth: 1, order: 1 })
      .lean<CategoryDoc[]>();
    return docs.map(toCategory);
  },

  async findCategory(idOrSlug: string): Promise<CategoryRecord | null> {
    const filter = Types.ObjectId.isValid(idOrSlug)
      ? { _id: idOrSlug }
      : { slug: idOrSlug.toLowerCase() };
    const doc = await CategoryModel.findOne(filter).lean<CategoryDoc>();
    return doc ? toCategory(doc) : null;
  },

  async findCategoriesByIds(ids: readonly string[]): Promise<CategoryRecord[]> {
    if (ids.length === 0) return [];
    const docs = await CategoryModel.find({ _id: { $in: ids } }).lean<CategoryDoc[]>();
    return docs.map(toCategory);
  },

  async createCategory(input: {
    parentId: string | null;
    ancestors: Array<{ id: string; slug: string; name: LocalizedText }>;
    depth: number;
    slug: string;
    name: LocalizedText;
    description: LocalizedText | null;
    icon: string | null;
    defaultUnit: string;
    allowedUnits: string[];
    defaultTolerancePercent: number;
    attributeSchema: AttributeDefinition[];
    order: number;
  }): Promise<CategoryRecord> {
    const doc = await CategoryModel.create({
      parentId: input.parentId ? new Types.ObjectId(input.parentId) : null,
      ancestors: input.ancestors.map((ancestor) => ({
        _id: new Types.ObjectId(ancestor.id),
        slug: ancestor.slug,
        name: ancestor.name,
      })),
      depth: input.depth,
      slug: input.slug,
      name: input.name,
      description: input.description,
      icon: input.icon,
      defaultUnit: input.defaultUnit,
      allowedUnits: input.allowedUnits,
      defaultTolerancePercent: input.defaultTolerancePercent,
      attributeSchema: input.attributeSchema,
      order: input.order,
    });
    return toCategory(doc.toObject<CategoryDoc>());
  },

  async updateCategory(id: string, patch: Record<string, unknown>): Promise<CategoryRecord | null> {
    const doc = await CategoryModel.findByIdAndUpdate(
      id,
      { $set: patch },
      { new: true, runValidators: true },
    ).lean<CategoryDoc>();
    return doc ? toCategory(doc) : null;
  },

  /**
   * Rewrites the embedded ancestor entry of a renamed category across its whole subtree.
   *
   * This is the cost of a materialised path, paid on a rare admin action rather than on every
   * read. A positional filtered update touches only the matching array element, so the rest
   * of each descendant document is untouched.
   */
  async renameInDescendants(
    categoryId: string,
    slug: string,
    name: LocalizedText,
  ): Promise<number> {
    const result = await CategoryModel.updateMany(
      { 'ancestors._id': new Types.ObjectId(categoryId) },
      { $set: { 'ancestors.$[entry].slug': slug, 'ancestors.$[entry].name': name } },
      { arrayFilters: [{ 'entry._id': new Types.ObjectId(categoryId) }] },
    );
    return result.modifiedCount;
  },

  async countChildren(categoryId: string): Promise<number> {
    return CategoryModel.countDocuments({ parentId: categoryId });
  },

  async slugExists(slug: string): Promise<boolean> {
    return (await CategoryModel.countDocuments({ slug }).limit(1)) > 0;
  },

  async incrementProductCount(categoryIds: readonly string[], delta: number): Promise<void> {
    if (categoryIds.length === 0) return;
    // The whole ancestor chain is counted, so a parent's count includes its descendants.
    await CategoryModel.updateMany(
      { _id: { $in: categoryIds.map((id) => new Types.ObjectId(id)) } },
      { $inc: { productCount: delta } },
    );
  },
};
