import { Types } from 'mongoose';
import type { Logger } from '@bozorlar/logger';
import { CategoryModel } from '../modules/catalog/models/category.model.js';
import { UnitModel } from '../modules/catalog/models/unit.model.js';
import { SEED_CATEGORIES, SEED_UNITS, type SeedCategory } from './catalog.data.js';

export interface CatalogSeedResult {
  unitsUpserted: number;
  categoriesInserted: number;
  categoriesUpdated: number;
}

/**
 * Idempotent catalogue seeder.
 *
 * Matched on `code` and `slug`, which are stable, so re-running corrects names in place
 * without detaching products from their category. Nothing is deleted: a category that
 * disappears from the seed is deactivated by hand, because removing it would orphan every
 * product inside it (DATABASE.md 3.2).
 */
export async function seedCatalog(logger: Logger): Promise<CatalogSeedResult> {
  const result: CatalogSeedResult = { unitsUpserted: 0, categoriesInserted: 0, categoriesUpdated: 0 };

  for (const [index, unit] of SEED_UNITS.entries()) {
    await UnitModel.updateOne(
      { code: unit.code },
      {
        $set: {
          name: unit.name,
          shortName: unit.shortName,
          decimalPlaces: unit.decimalPlaces,
          allowsAdjustment: unit.allowsAdjustment,
          order: index,
          isActive: true,
        },
        $setOnInsert: { code: unit.code, schemaVersion: 1 },
      },
      { upsert: true, setDefaultsOnInsert: true },
    );
    result.unitsUpserted += 1;
  }

  async function upsertCategory(
    category: SeedCategory,
    parent: { id: Types.ObjectId; slug: string; name: SeedCategory['name']; ancestors: Array<{ _id: Types.ObjectId; slug: string; name: SeedCategory['name'] }> } | null,
    order: number,
  ): Promise<void> {
    const ancestors = parent ? [...parent.ancestors, { _id: parent.id, slug: parent.slug, name: parent.name }] : [];
    const existing = await CategoryModel.findOne({ slug: category.slug }, { _id: 1 }).lean<{ _id: Types.ObjectId }>();

    const doc = await CategoryModel.findOneAndUpdate(
      { slug: category.slug },
      {
        $set: {
          parentId: parent?.id ?? null,
          ancestors,
          depth: ancestors.length,
          name: category.name,
          icon: category.icon ?? null,
          defaultUnit: category.defaultUnit,
          allowedUnits: category.allowedUnits,
          // A category that declares no tolerance inherits the platform default rather than
          // silently becoming zero, which would break handover adjustment for weighed goods.
          defaultTolerancePercent: category.defaultTolerancePercent ?? 1000,
          attributeSchema: (category.attributes ?? []).map((attribute, attributeOrder) => ({
            key: attribute.key,
            type: attribute.type,
            name: attribute.name,
            options: attribute.options ?? [],
            required: attribute.required ?? false,
            order: attribute.order ?? attributeOrder,
          })),
          order,
          isActive: true,
        },
        $setOnInsert: { slug: category.slug, schemaVersion: 1 },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true },
    ).lean<{ _id: Types.ObjectId }>();

    if (existing) result.categoriesUpdated += 1;
    else result.categoriesInserted += 1;

    for (const [childOrder, child] of (category.children ?? []).entries()) {
      await upsertCategory(
        child,
        { id: doc._id, slug: category.slug, name: category.name, ancestors },
        childOrder,
      );
    }
  }

  for (const [order, category] of SEED_CATEGORIES.entries()) {
    await upsertCategory(category, null, order);
  }

  logger.info(result, 'catalog seed complete');
  return result;
}
