import mongoose from 'mongoose';
import { AppError, ErrorCode, notFound } from '@bozorlar/errors';
import type { Logger } from '@bozorlar/logger';
import { Money, Quantity } from '@bozorlar/money';
import { computeProductVisibility, isPurchasable } from '@bozorlar/domain';
import {
  ActorType,
  AuditSeverity,
  ModerationStatus,
  type LocalizedText,
} from '@bozorlar/types';
import { outboxService } from '../../outbox/index.js';
import type { AuditService } from '../../audit/index.js';
import { MediaPurpose, type MediaService } from '../../media/index.js';
import { generateUniqueSlug } from '../../geo/index.js';
import { CacheTag, type Cache } from '../../../shared/cache.js';
import { parseQuery, toPage, type Page, type QuerySpec } from '../../../http/query.js';
import {
  DEFAULT_TOLERANCE_BP,
  LIVE_PRODUCT_STATUSES,
  MAX_PRODUCT_IMAGES,
  PRODUCT_TRANSITIONS,
  ProductStatus,
  RATING_PRIOR_COUNT,
  RATING_PRIOR_VALUE,
  REMODERATION_FIELDS,
} from '../catalog.constants.js';
import { productRepository, type ProductRecord } from '../repositories/product.repository.js';
import type { CategoryService } from './category.service.js';
import { validateAttributes } from './attributes.service.js';
import { CatalogEvents } from '../events.js';

export const PRODUCT_QUERY_SPEC: QuerySpec = {
  filters: [
    { field: 'categoryId', type: 'objectId', operators: ['eq', 'in'], path: 'categoryPath' },
    { field: 'shopId', type: 'objectId', operators: ['eq', 'in'] },
    { field: 'marketId', type: 'objectId', operators: ['eq', 'in'] },
    { field: 'districtId', type: 'objectId', operators: ['eq', 'in'] },
    { field: 'regionId', type: 'objectId', operators: ['eq'] },
    { field: 'price', type: 'number', operators: ['gte', 'lte'] },
    { field: 'rating', type: 'number', operators: ['gte'], path: 'ratingBayesian' },
  ],
  sorts: [
    { key: '-createdAt', sort: { createdAt: -1, _id: -1 } },
    { key: 'price', sort: { price: 1, _id: 1 } },
    { key: '-price', sort: { price: -1, _id: -1 } },
    { key: '-rating', sort: { ratingBayesian: -1, _id: -1 } },
    { key: '-salesCount', sort: { salesCount: -1, _id: -1 } },
  ],
  defaultSort: '-createdAt',
};

export const SELLER_PRODUCT_QUERY_SPEC: QuerySpec = {
  filters: [
    { field: 'shopId', type: 'objectId', operators: ['eq', 'in'] },
    { field: 'status', type: 'string', operators: ['eq', 'in'] },
    { field: 'moderationStatus', type: 'string', operators: ['eq', 'in'] },
    { field: 'categoryId', type: 'objectId', operators: ['eq'], path: 'categoryPath' },
  ],
  sorts: [
    { key: '-createdAt', sort: { createdAt: -1, _id: -1 } },
    { key: '-salesCount', sort: { salesCount: -1, _id: -1 } },
    { key: 'price', sort: { price: 1, _id: 1 } },
  ],
  defaultSort: '-createdAt',
};

/** Shop facts the catalogue needs. A narrow port, not the whole geo module. */
export interface ShopContext {
  id: string;
  marketId: string;
  districtId: string;
  regionId: string;
  isVisible: boolean;
}

export interface ShopLookup {
  forProduct(shopId: string): Promise<ShopContext | null>;
}

export interface CreateProductCommand {
  shopId: string;
  categoryId: string;
  name: LocalizedText;
  description?: LocalizedText | undefined;
  images: string[];
  unit: string;
  price: string;
  oldPrice?: string | undefined;
  stockQty: string;
  minOrderQty: string;
  stepQty: string;
  maxOrderQty?: string | undefined;
  tolerancePercent?: number | undefined;
  attributes?: Record<string, unknown> | undefined;
  tags?: string[] | undefined;
}

export interface ProductView extends ProductRecord {
  isPurchasable: boolean;
  discountPercent: number | null;
}

function bayesian(ratingAvg: number, ratingCount: number): number {
  // A single five-star review must not outrank a shop with four hundred at 4.8.
  const total = RATING_PRIOR_VALUE * RATING_PRIOR_COUNT + ratingAvg * ratingCount;
  return Math.round(total / (RATING_PRIOR_COUNT + ratingCount));
}

function assertTransition(from: ProductStatus, to: ProductStatus): void {
  if (from === to) return;
  if (!PRODUCT_TRANSITIONS[from].includes(to)) {
    throw new AppError(ErrorCode.RESOURCE_CONFLICT, {
      detail: `A product cannot move from ${from} to ${to}`,
      params: { from, to, allowed: PRODUCT_TRANSITIONS[from] },
    });
  }
}

export function createProductService(deps: {
  categories: CategoryService;
  shops: ShopLookup;
  media: MediaService;
  cache: Cache;
  audit: AuditService;
  logger: Logger;
}) {
  const { categories, shops, media, cache, audit, logger } = deps;

  function decorate(product: ProductRecord): ProductView {
    const purchasable = isPurchasable({
      isVisible: product.isVisible,
      availableQtyMilli: product.availableQty.milli,
      minOrderQtyMilli: product.minOrderQty.milli,
    });
    const discount =
      product.oldPrice === null
        ? null
        : Math.round(
            Number(((product.oldPrice.minor - product.price.minor) * 100n) / product.oldPrice.minor),
          );
    return { ...product, isPurchasable: purchasable, discountPercent: discount };
  }

  /** Status follows stock automatically, so a seller never has to remember to toggle it. */
  function statusForStock(current: ProductStatus, stock: Quantity, minOrder: Quantity): ProductStatus {
    if (!LIVE_PRODUCT_STATUSES.includes(current)) return current;
    return stock.milli < minOrder.milli ? ProductStatus.OUT_OF_STOCK : ProductStatus.ACTIVE;
  }

  async function buildQuantities(
    command: Pick<CreateProductCommand, 'unit' | 'stockQty' | 'minOrderQty' | 'stepQty' | 'maxOrderQty'>,
  ) {
    const unit = await categories.requireUnit(command.unit);
    const stock = Quantity.of(command.stockQty, unit.code);
    const minOrder = Quantity.of(command.minOrderQty, unit.code);
    const step = Quantity.of(command.stepQty, unit.code);
    const max = command.maxOrderQty === undefined ? null : Quantity.of(command.maxOrderQty, unit.code);

    if (unit.decimalPlaces === 0) {
      // Countable goods cannot be sold in fractions: half an egg is not an order.
      for (const [field, quantity] of [['minOrderQty', minOrder], ['stepQty', step], ['stockQty', stock]] as const) {
        if (quantity.milli % 1000n !== 0n) {
          throw new AppError(ErrorCode.VALIDATION_FAILED, {
            detail: `${command.unit} is sold in whole units`,
            errors: [{ field, code: 'FRACTIONAL_NOT_ALLOWED' }],
          });
        }
      }
    }
    if (minOrder.milli % step.milli !== 0n) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        detail: 'The minimum order must be a whole number of steps',
        errors: [{ field: 'minOrderQty', code: 'NOT_A_MULTIPLE_OF_STEP' }],
      });
    }
    return { unit, stock, minOrder, step, max };
  }

  return {
    async create(command: CreateProductCommand, actor: { userId: string; shopIds: readonly string[] }): Promise<ProductView> {
      if (!actor.shopIds.includes(command.shopId)) throw notFound('Shop', 'PERM_SCOPE_DENIED');
      const shop = await shops.forProduct(command.shopId);
      if (!shop) throw notFound('Shop');

      const category = await categories.get(command.categoryId);
      if (!category.isActive) {
        throw new AppError(ErrorCode.CATALOG_CATEGORY_NOT_FOUND, { detail: 'This category is closed' });
      }
      if (!category.allowedUnits.includes(command.unit)) {
        throw new AppError(ErrorCode.CATALOG_UNIT_NOT_ALLOWED, {
          detail: `${command.unit} is not accepted in this category`,
          params: { allowed: category.allowedUnits },
        });
      }

      const { unit, stock, minOrder, step, max } = await buildQuantities(command);
      const price = Money.of(command.price);
      const oldPrice = command.oldPrice === undefined ? null : Money.of(command.oldPrice);
      if (!price.isPositive()) {
        throw new AppError(ErrorCode.CATALOG_PRICE_INVALID, { detail: 'Price must be above zero' });
      }
      if (oldPrice && oldPrice.lessThanOrEqual(price)) {
        throw new AppError(ErrorCode.CATALOG_PRICE_INVALID, {
          detail: 'The previous price must be higher than the current one',
          errors: [{ field: 'oldPrice', code: 'NOT_A_DISCOUNT' }],
        });
      }

      if (command.images.length === 0 || command.images.length > MAX_PRODUCT_IMAGES) {
        throw new AppError(ErrorCode.CATALOG_IMAGE_REQUIRED, {
          detail: `A product needs between 1 and ${MAX_PRODUCT_IMAGES} images`,
        });
      }
      const resolved = await media.resolveMany(command.images);
      const images = command.images.map((mediaKey, order) => {
        const asset = resolved.get(mediaKey);
        if (!asset) {
          throw new AppError(ErrorCode.MEDIA_UPLOAD_NOT_CONFIRMED, {
            detail: `Image ${mediaKey} has not been confirmed`,
          });
        }
        return {
          mediaKey,
          width: asset.width,
          height: asset.height,
          blurhash: asset.blurhash,
          order,
        };
      });

      const schema = await categories.resolveAttributeSchema(category.id);
      const attributes = validateAttributes(command.attributes ?? {}, schema);

      const slug = await generateUniqueSlug(command.name.uz, (candidate) =>
        productRepository.slugExists(candidate),
      );
      const categoryPath = [...category.ancestors.map((ancestor) => ancestor.id), category.id];

      const session = await mongoose.startSession();
      let created: ProductRecord;
      try {
        created = await session.withTransaction(async () => {
          const product = await productRepository.create(
            {
              shopId: shop.id,
              marketId: shop.marketId,
              districtId: shop.districtId,
              regionId: shop.regionId,
              categoryId: category.id,
              categoryPath,
              name: command.name,
              description: command.description ?? null,
              images,
              unit: unit.code,
              price,
              oldPrice,
              stockQty: stock,
              minOrderQty: minOrder,
              stepQty: step,
              maxOrderQty: max,
              tolerancePercent:
                command.tolerancePercent ?? category.defaultTolerancePercent ?? DEFAULT_TOLERANCE_BP,
              attributes,
              tags: command.tags ?? [],
              // Nothing reaches the catalogue without moderation.
              status: ProductStatus.PENDING_MODERATION,
              shopVisible: shop.isVisible,
              slug,
            },
            session,
          );

          // Attaching inside the transaction is what stops the orphan sweeper reclaiming the
          // images out from under a product that was just created.
          await media.attachToEntity({
            mediaKeys: command.images,
            target: { type: 'product', id: product.id },
            expectedPurpose: MediaPurpose.PRODUCT_IMAGE,
            ownerId: actor.userId,
            session,
          });

          await outboxService.publish(
            {
              type: CatalogEvents.PRODUCT_CREATED,
              aggregateType: 'product',
              aggregateId: product.id,
              payload: { productId: product.id, shopId: shop.id, categoryId: category.id },
              actorId: actor.userId,
              actorType: ActorType.USER,
            },
            session,
          );
          return product;
        });
      } finally {
        await session.endSession();
      }

      await productRepository.recordPriceChange({
        productId: created.id,
        shopId: shop.id,
        price,
        previousPrice: null,
        changedBy: actor.userId,
      });
      await cache.invalidateTags(CacheTag.productsOfShop(shop.id), CacheTag.categories());
      logger.info({ productId: created.id, shopId: shop.id }, 'product created');
      return decorate(created);
    },

    async getPublic(idOrSlug: string): Promise<ProductView> {
      const product = await productRepository.findByIdOrSlug(idOrSlug);
      // Invisible products are reported missing so the public API cannot be used to discover
      // unmoderated or suspended listings (ADR-0029).
      if (!product || !product.isVisible) {
        throw notFound('Product', product ? `NOT_VISIBLE reason=${product.visibilityReason}` : undefined);
      }
      return decorate(product);
    },

    async getForSeller(productId: string, actorShopIds: readonly string[]): Promise<ProductView> {
      const product = await productRepository.findById(productId);
      if (!product) throw notFound('Product');
      if (!actorShopIds.includes(product.shopId)) throw notFound('Product', 'PERM_SCOPE_DENIED');
      return decorate(product);
    },

    async listPublic(query: Record<string, unknown>): Promise<Page<ProductView>> {
      // isVisible is forced server-side: no filter value can surface hidden products.
      const parsed = parseQuery(query, PRODUCT_QUERY_SPEC);
      const rows = await productRepository.list(parsed, { isVisible: true });
      const page = toPage(rows as unknown as Record<string, unknown>[], parsed);
      return {
        items: (page.items as unknown as ProductRecord[]).map(decorate),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      };
    },

    async listForSeller(
      query: Record<string, unknown>,
      actorShopIds: readonly string[],
    ): Promise<Page<ProductView>> {
      if (actorShopIds.length === 0) return { items: [], nextCursor: null, hasMore: false };
      const parsed = parseQuery(query, SELLER_PRODUCT_QUERY_SPEC);
      const rows = await productRepository.list(parsed, { shopId: { $in: actorShopIds } });
      const page = toPage(rows as unknown as Record<string, unknown>[], parsed);
      return {
        items: (page.items as unknown as ProductRecord[]).map(decorate),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      };
    },

    /**
     * The moderation queue.
     *
     * Added when the admin panel needed it: the platform could count products awaiting review
     * — the reports module aggregates it — but had no way to list them, so the queue was
     * visible and unworkable. Oldest first, because a queue worked newest-first leaves its
     * oldest item there indefinitely.
     */
    async listForModeration(query: Record<string, unknown>): Promise<Page<ProductView>> {
      const parsed = parseQuery({ ...query, sort: 'createdAt' }, SELLER_PRODUCT_QUERY_SPEC);
      const rows = await productRepository.list(parsed, {
        status: ProductStatus.PENDING_MODERATION,
        deletedAt: null,
      });
      const page = toPage(rows as unknown as Record<string, unknown>[], parsed);
      return {
        items: (page.items as unknown as ProductRecord[]).map(decorate),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      };
    },

    /**
     * Updates a product's descriptive fields.
     *
     * Touching name, description, images or category returns the product to moderation; price
     * and stock have their own endpoints and never do (MODERATION.md).
     */
    async update(
      productId: string,
      actor: { userId: string; shopIds: readonly string[] },
      patch: {
        name?: LocalizedText;
        description?: LocalizedText;
        categoryId?: string;
        images?: string[];
        attributes?: Record<string, unknown>;
        tags?: string[];
      },
    ): Promise<ProductView> {
      const existing = await this.getForSeller(productId, actor.shopIds);
      if (existing.status === ProductStatus.ARCHIVED) {
        throw new AppError(ErrorCode.RESOURCE_CONFLICT, { detail: 'An archived product cannot be edited' });
      }

      const update: Record<string, unknown> = {};
      let nextCategoryId = existing.categoryId;

      if (patch.categoryId && patch.categoryId !== existing.categoryId) {
        const category = await categories.get(patch.categoryId);
        if (!category.allowedUnits.includes(existing.unit)) {
          throw new AppError(ErrorCode.CATALOG_UNIT_NOT_ALLOWED, {
            detail: `This product is sold in ${existing.unit}, which the new category does not accept`,
          });
        }
        update.categoryId = new mongoose.Types.ObjectId(category.id);
        update.categoryPath = [...category.ancestors.map((a) => a.id), category.id].map(
          (id) => new mongoose.Types.ObjectId(id),
        );
        nextCategoryId = category.id;
      }

      if (patch.name) update.name = patch.name;
      if (patch.description !== undefined) update.description = patch.description;
      if (patch.tags) update.tags = patch.tags;

      if (patch.images) {
        if (patch.images.length === 0 || patch.images.length > MAX_PRODUCT_IMAGES) {
          throw new AppError(ErrorCode.CATALOG_IMAGE_REQUIRED, {
            detail: `A product needs between 1 and ${MAX_PRODUCT_IMAGES} images`,
          });
        }
        const resolved = await media.resolveMany(patch.images);
        update.images = patch.images.map((mediaKey, order) => {
          const asset = resolved.get(mediaKey);
          if (!asset) {
            throw new AppError(ErrorCode.MEDIA_UPLOAD_NOT_CONFIRMED, {
              detail: `Image ${mediaKey} has not been confirmed`,
            });
          }
          return { mediaKey, width: asset.width, height: asset.height, blurhash: asset.blurhash, order };
        });
      }

      if (patch.attributes) {
        const schema = await categories.resolveAttributeSchema(nextCategoryId);
        update.attributes = validateAttributes(patch.attributes, schema);
      }

      const touchesIdentity = REMODERATION_FIELDS.some((field) => field in patch);
      const wasApproved = existing.moderationStatus === ModerationStatus.APPROVED;
      if (touchesIdentity && wasApproved) {
        update.moderationStatus = ModerationStatus.PENDING;
        update.moderationReason = null;
        update.status = ProductStatus.PENDING_MODERATION;
        update.isVisible = false;
        update.visibilityReason = 'MODERATION_NOT_APPROVED';
        update.visibilityComputedAt = new Date();
      }

      const session = await mongoose.startSession();
      let updated: ProductRecord;
      try {
        updated = await session.withTransaction(async () => {
          if (patch.images) {
            await media.detachFromEntity({ type: 'product', id: productId }, session);
            await media.attachToEntity({
              mediaKeys: patch.images,
              target: { type: 'product', id: productId },
              expectedPurpose: MediaPurpose.PRODUCT_IMAGE,
              ownerId: actor.userId,
              session,
            });
          }
          const next = await productRepository.update(productId, update, session);
          if (!next) throw notFound('Product');

          await outboxService.publish(
            {
              type: CatalogEvents.PRODUCT_UPDATED,
              aggregateType: 'product',
              aggregateId: productId,
              payload: { productId, fields: Object.keys(patch), remoderated: touchesIdentity && wasApproved },
              actorId: actor.userId,
              actorType: ActorType.USER,
            },
            session,
          );
          return next;
        });
      } finally {
        await session.endSession();
      }

      await cache.invalidateTags(CacheTag.product(productId), CacheTag.productsOfShop(existing.shopId));
      return decorate(updated);
    },

    /**
     * The highest-frequency seller write in the system, so it is its own minimal endpoint.
     *
     * Bazaar prices move daily; routing them through the general update path would drag
     * moderation and image resolution into a call that changes one integer.
     */
    async setPrice(
      productId: string,
      actor: { userId: string; shopIds: readonly string[] },
      input: { price: string; oldPrice?: string | null },
    ): Promise<ProductView> {
      const existing = await this.getForSeller(productId, actor.shopIds);
      const price = Money.of(input.price);
      if (!price.isPositive()) {
        throw new AppError(ErrorCode.CATALOG_PRICE_INVALID, { detail: 'Price must be above zero' });
      }
      const oldPrice =
        input.oldPrice === undefined || input.oldPrice === null ? null : Money.of(input.oldPrice);
      if (oldPrice && oldPrice.lessThanOrEqual(price)) {
        throw new AppError(ErrorCode.CATALOG_PRICE_INVALID, {
          detail: 'The previous price must be higher than the current one',
        });
      }
      if (existing.price.equals(price) && oldPrice === null) return decorate(existing);

      const session = await mongoose.startSession();
      let updated: ProductRecord;
      try {
        updated = await session.withTransaction(async () => {
          const next = await productRepository.update(
            productId,
            { price: price.minor, oldPrice: oldPrice?.minor ?? null },
            session,
          );
          if (!next) throw notFound('Product');
          await outboxService.publish(
            {
              type: CatalogEvents.PRODUCT_PRICE_CHANGED,
              aggregateType: 'product',
              aggregateId: productId,
              payload: { productId, from: existing.price.toStorage(), to: price.toStorage() },
              actorId: actor.userId,
              actorType: ActorType.USER,
            },
            session,
          );
          return next;
        });
      } finally {
        await session.endSession();
      }

      // Written after commit: the price history is a time-series collection and cannot join
      // a multi-document transaction. Losing a history row is cosmetic; losing the price is not.
      await productRepository.recordPriceChange({
        productId,
        shopId: existing.shopId,
        price,
        previousPrice: existing.price,
        changedBy: actor.userId,
      });
      await cache.invalidateTags(CacheTag.product(productId), CacheTag.productsOfShop(existing.shopId));
      return decorate(updated);
    },

    async setStock(
      productId: string,
      actor: { userId: string; shopIds: readonly string[] },
      stockQty: string,
    ): Promise<ProductView> {
      const existing = await this.getForSeller(productId, actor.shopIds);
      const stock = Quantity.of(stockQty, existing.unit);
      if (stock.milli < existing.reservedQty.milli) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, {
          detail: 'Stock cannot be set below the quantity already reserved by open checkouts',
          params: { reserved: existing.reservedQty.toDecimalString() },
        });
      }

      const nextStatus = statusForStock(existing.status, stock, existing.minOrderQty);
      const session = await mongoose.startSession();
      let updated: ProductRecord;
      try {
        updated = await session.withTransaction(async () => {
          const next = await productRepository.setStock(productId, stock, nextStatus, session);
          if (!next) throw notFound('Product');
          await outboxService.publish(
            {
              type: CatalogEvents.PRODUCT_STOCK_CHANGED,
              aggregateType: 'product',
              aggregateId: productId,
              payload: { productId, stock: stock.toStorage(), status: nextStatus },
              actorId: actor.userId,
              actorType: ActorType.USER,
            },
            session,
          );
          return next;
        });
      } finally {
        await session.endSession();
      }

      await cache.invalidateTags(CacheTag.product(productId), CacheTag.productsOfShop(existing.shopId));
      return decorate(updated);
    },

    async archive(productId: string, actor: { userId: string; shopIds: readonly string[] }): Promise<void> {
      const existing = await this.getForSeller(productId, actor.shopIds);
      assertTransition(existing.status, ProductStatus.ARCHIVED);

      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const archived = await productRepository.softDelete(productId, session);
          if (!archived) throw notFound('Product');
          await media.detachFromEntity({ type: 'product', id: productId }, session);
          await outboxService.publish(
            {
              type: CatalogEvents.PRODUCT_ARCHIVED,
              aggregateType: 'product',
              aggregateId: productId,
              payload: { productId, shopId: existing.shopId },
              actorId: actor.userId,
              actorType: ActorType.USER,
            },
            session,
          );
        });
      } finally {
        await session.endSession();
      }

      await audit.record({
        actorId: actor.userId,
        actorType: ActorType.USER,
        action: 'product.archived',
        targetType: 'product',
        targetId: productId,
      });
      await cache.invalidateTags(CacheTag.product(productId), CacheTag.productsOfShop(existing.shopId));
    },

    async moderate(
      productId: string,
      moderatorId: string,
      decision: { approved: boolean; reason?: string | undefined },
    ): Promise<ProductView> {
      const existing = await productRepository.findById(productId);
      if (!existing) throw notFound('Product');
      if (!decision.approved && !decision.reason) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, {
          detail: 'A rejection reason is required',
          errors: [{ field: 'reason', code: 'REQUIRED' }],
        });
      }

      const nextStatus = decision.approved
        ? statusForStock(ProductStatus.ACTIVE, existing.stockQty, existing.minOrderQty)
        : ProductStatus.DRAFT;
      const visibility = computeProductVisibility({
        isLiveStatus: decision.approved && LIVE_PRODUCT_STATUSES.includes(nextStatus),
        moderationApproved: decision.approved,
        shopVisible: existing.shopVisible,
      });

      const session = await mongoose.startSession();
      let updated: ProductRecord;
      try {
        updated = await session.withTransaction(async () => {
          const next = await productRepository.update(
            productId,
            {
              moderationStatus: decision.approved ? ModerationStatus.APPROVED : ModerationStatus.REJECTED,
              moderationReason: decision.reason ?? null,
              status: nextStatus,
              isVisible: visibility.isVisible,
              visibilityReason: visibility.reason,
              visibilityComputedAt: new Date(),
              ...(decision.approved && existing.publishedAt === null ? { publishedAt: new Date() } : {}),
            },
            session,
          );
          if (!next) throw notFound('Product');
          await outboxService.publish(
            {
              type: CatalogEvents.PRODUCT_MODERATION_DECIDED,
              aggregateType: 'product',
              aggregateId: productId,
              payload: { productId, approved: decision.approved, reason: decision.reason ?? null },
              actorId: moderatorId,
              actorType: ActorType.ADMIN,
            },
            session,
          );
          return next;
        });
      } finally {
        await session.endSession();
      }

      await audit.record({
        actorId: moderatorId,
        actorType: ActorType.ADMIN,
        action: decision.approved ? 'product.moderation_approved' : 'product.moderation_rejected',
        targetType: 'product',
        targetId: productId,
        reason: decision.reason ?? null,
        after: { isVisible: updated.isVisible },
        severity: AuditSeverity.WARNING,
      });
      await cache.invalidateTags(CacheTag.product(productId), CacheTag.productsOfShop(existing.shopId));
      return decorate(updated);
    },

    async priceHistory(productId: string, days: number): Promise<Array<{ price: string; at: string }>> {
      await this.getPublic(productId);
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const history = await productRepository.priceHistory(productId, since);
      return history.map((entry) => ({ price: entry.price.toStorage(), at: entry.at.toISOString() }));
    },

    /**
     * Batch lookup for checkout.
     *
     * Returns everything a quote needs to price and validate a line, in one query. Deliberately
     * not `findById` in a loop: a twelve-line cart would otherwise be twelve round trips on the
     * most latency-sensitive call in the buyer journey.
     */
    async findForCheckout(productIds: readonly string[]): Promise<Map<string, ProductRecord>> {
      if (productIds.length === 0) return new Map();
      const parsed = parseQuery({ limit: '100' }, PRODUCT_QUERY_SPEC);
      const rows = await productRepository.list(
        { ...parsed, limit: productIds.length },
        { _id: { $in: productIds.filter((id) => mongoose.Types.ObjectId.isValid(id)).map((id) => new mongoose.Types.ObjectId(id)) } },
      );
      return new Map(rows.map((product) => [product.id, product]));
    },

    /** Called by the worker when a shop's visibility changes. */
    async cascadeShopVisibility(shopId: string, shopVisible: boolean) {
      return productRepository.cascadeShopVisibility(shopId, shopVisible);
    },

    recomputeBayesian: bayesian,
  };
}

export type ProductService = ReturnType<typeof createProductService>;
