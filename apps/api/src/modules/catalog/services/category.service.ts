import { AppError, ErrorCode, notFound } from '@bozorlar/errors';
import type { Logger } from '@bozorlar/logger';
import { ActorType, type LocalizedText } from '@bozorlar/types';
import { CacheTag, type Cache } from '../../../shared/cache.js';
import type { AuditService } from '../../audit/index.js';
import { generateUniqueSlug } from '../../geo/index.js';
import {
  catalogReferenceRepository,
  type CategoryRecord,
  type UnitRecord,
} from '../repositories/catalogReference.repository.js';
import { productRepository } from '../repositories/product.repository.js';
import { mergeAttributeSchemas } from './attributes.service.js';
import { MAX_CATEGORY_DEPTH } from '../catalog.constants.js';
import type { AttributeDefinition } from '../models/category.model.js';

const CATEGORY_TTL = 60 * 60;
const UNIT_TTL = 24 * 60 * 60;

export interface CategoryNode extends CategoryRecord {
  children: CategoryNode[];
}

export interface CreateCategoryCommand {
  parentId: string | null;
  name: LocalizedText;
  description?: LocalizedText | undefined;
  icon?: string | undefined;
  defaultUnit: string;
  allowedUnits: string[];
  defaultTolerancePercent?: number | undefined;
  attributeSchema?: AttributeDefinition[] | undefined;
  order?: number | undefined;
}

export function createCategoryService(deps: { cache: Cache; audit: AuditService; logger: Logger }) {
  const { cache, audit, logger } = deps;

  async function allCategories(): Promise<CategoryRecord[]> {
    return cache.readThrough(
      'categories:all',
      { ttlSeconds: CATEGORY_TTL, tags: [CacheTag.categories()] },
      () => catalogReferenceRepository.listCategories(),
    );
  }

  return {
    async listUnits(): Promise<UnitRecord[]> {
      return cache.readThrough(
        'units',
        { ttlSeconds: UNIT_TTL, tags: [CacheTag.units()] },
        () => catalogReferenceRepository.listUnits(),
      );
    },

    async requireUnit(code: string): Promise<UnitRecord> {
      const unit = (await this.listUnits()).find((candidate) => candidate.code === code);
      if (!unit) {
        throw new AppError(ErrorCode.CATALOG_UNIT_NOT_ALLOWED, {
          detail: `"${code}" is not a known unit of sale`,
        });
      }
      return unit;
    },

    /** Builds the tree in memory from one flat, cached read rather than N queries. */
    async tree(rootId?: string): Promise<CategoryNode[]> {
      const categories = await allCategories();
      const byParent = new Map<string | null, CategoryRecord[]>();
      for (const category of categories) {
        const key = category.parentId;
        const siblings = byParent.get(key) ?? [];
        siblings.push(category);
        byParent.set(key, siblings);
      }

      const build = (parentId: string | null): CategoryNode[] =>
        (byParent.get(parentId) ?? [])
          .sort((a, b) => a.order - b.order)
          .map((category) => ({ ...category, children: build(category.id) }));

      return build(rootId ?? null);
    },

    async get(idOrSlug: string): Promise<CategoryRecord> {
      const categories = await allCategories();
      const found = categories.find(
        (category) => category.id === idOrSlug || category.slug === idOrSlug.toLowerCase(),
      );
      if (!found) throw notFound('Category');
      return found;
    },

    /**
     * The effective attribute schema for a category: its own definitions merged over every
     * ancestor's, nearest ancestor winning.
     */
    async resolveAttributeSchema(categoryId: string): Promise<AttributeDefinition[]> {
      const categories = await allCategories();
      const byId = new Map(categories.map((category) => [category.id, category]));
      const category = byId.get(categoryId);
      if (!category) throw notFound('Category');

      const chain = [
        ...category.ancestors.map((ancestor) => byId.get(ancestor.id)?.attributeSchema ?? []),
        category.attributeSchema,
      ];
      return mergeAttributeSchemas(chain);
    },

    async create(command: CreateCategoryCommand, actorId: string): Promise<CategoryRecord> {
      let parent: CategoryRecord | null = null;
      if (command.parentId) {
        parent = await this.get(command.parentId);
        if (parent.depth + 1 >= MAX_CATEGORY_DEPTH) {
          throw new AppError(ErrorCode.VALIDATION_FAILED, {
            detail: `Categories may nest at most ${MAX_CATEGORY_DEPTH} levels`,
          });
        }
      }

      for (const unit of command.allowedUnits) await this.requireUnit(unit);
      if (!command.allowedUnits.includes(command.defaultUnit)) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, {
          detail: 'defaultUnit must be one of allowedUnits',
          errors: [{ field: 'defaultUnit', code: 'NOT_IN_ALLOWED_UNITS' }],
        });
      }

      const slug = await generateUniqueSlug(command.name.uz, (candidate) =>
        catalogReferenceRepository.slugExists(candidate),
      );

      const created = await catalogReferenceRepository.createCategory({
        parentId: parent?.id ?? null,
        ancestors: parent
          ? [...parent.ancestors, { id: parent.id, slug: parent.slug, name: parent.name }]
          : [],
        depth: parent ? parent.depth + 1 : 0,
        slug,
        name: command.name,
        description: command.description ?? null,
        icon: command.icon ?? null,
        defaultUnit: command.defaultUnit,
        allowedUnits: command.allowedUnits,
        defaultTolerancePercent: command.defaultTolerancePercent ?? parent?.defaultTolerancePercent ?? 1000,
        attributeSchema: command.attributeSchema ?? [],
        order: command.order ?? 0,
      });

      await cache.invalidateTags(CacheTag.categories());
      await audit.record({
        actorId,
        actorType: ActorType.ADMIN,
        action: 'category.created',
        targetType: 'category',
        targetId: created.id,
        after: { slug, parentId: parent?.id ?? null },
      });
      return created;
    },

    /**
     * Updates a category and, when its display identity changes, rewrites the embedded copy
     * held by every descendant.
     *
     * That rewrite is the price of the materialised path. It is paid here, on a rare admin
     * action, instead of on every catalogue read.
     */
    async update(
      categoryId: string,
      patch: {
        name?: LocalizedText;
        description?: LocalizedText;
        icon?: string;
        allowedUnits?: string[];
        defaultUnit?: string;
        defaultTolerancePercent?: number;
        attributeSchema?: AttributeDefinition[];
        order?: number;
        isActive?: boolean;
      },
      actorId: string,
    ): Promise<CategoryRecord> {
      const existing = await this.get(categoryId);

      if (patch.allowedUnits) {
        for (const unit of patch.allowedUnits) await this.requireUnit(unit);
      }
      const nextAllowed = patch.allowedUnits ?? existing.allowedUnits;
      const nextDefault = patch.defaultUnit ?? existing.defaultUnit;
      if (!nextAllowed.includes(nextDefault)) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, {
          detail: 'defaultUnit must be one of allowedUnits',
        });
      }

      const updated = await catalogReferenceRepository.updateCategory(categoryId, patch);
      if (!updated) throw notFound('Category');

      let descendantsRewritten = 0;
      if (patch.name) {
        descendantsRewritten = await catalogReferenceRepository.renameInDescendants(
          categoryId,
          updated.slug,
          updated.name,
        );
      }

      await cache.invalidateTags(CacheTag.categories());
      await audit.record({
        actorId,
        actorType: ActorType.ADMIN,
        action: 'category.updated',
        targetType: 'category',
        targetId: categoryId,
        after: { fields: Object.keys(patch), descendantsRewritten },
      });
      if (descendantsRewritten > 0) {
        logger.info({ categoryId, descendantsRewritten }, 'category rename propagated');
      }
      return updated;
    },

    /**
     * Deactivating a category is refused while it still holds products or children.
     *
     * Cascading would orphan products into an invisible category; leaving them visible under
     * a deactivated branch would be worse. Requiring reassignment first is the only outcome
     * that keeps the catalogue coherent (DATABASE.md 3.2).
     */
    async deactivate(categoryId: string, actorId: string): Promise<void> {
      const existing = await this.get(categoryId);
      const children = await catalogReferenceRepository.countChildren(categoryId);
      if (children > 0) {
        throw new AppError(ErrorCode.RESOURCE_CONFLICT, {
          detail: 'Reassign or remove the subcategories first',
          params: { children },
        });
      }
      const products = await productRepository.countByCategory(categoryId);
      if (products > 0) {
        throw new AppError(ErrorCode.RESOURCE_CONFLICT, {
          detail: 'Reassign the products in this category first',
          params: { products },
        });
      }

      await catalogReferenceRepository.updateCategory(categoryId, { isActive: false });
      await cache.invalidateTags(CacheTag.categories());
      await audit.record({
        actorId,
        actorType: ActorType.ADMIN,
        action: 'category.deactivated',
        targetType: 'category',
        targetId: categoryId,
        before: { slug: existing.slug },
      });
    },
  };
}

export type CategoryService = ReturnType<typeof createCategoryService>;
