import { Types, type ClientSession } from 'mongoose';
import { Money, Quantity } from '@bozorlar/money';
import type { LocalizedText, ModerationStatus } from '@bozorlar/types';
import { ProductModel, type ProductDoc, type ProductImage } from '../models/product.model.js';
import { ProductPriceHistoryModel } from '../models/productPriceHistory.model.js';
import type { ProductStatus } from '../catalog.constants.js';
import type { ParsedQuery } from '../../../http/query.js';

/**
 * Products cross this boundary as value objects, never as raw numbers.
 *
 * The conversion happens exactly once, here. Anything downstream that wants to do arithmetic
 * has to go through `Money` and `Quantity`, which is what keeps the integer discipline of
 * ADR-0004 and ADR-0025 from leaking away one convenient `Number()` at a time.
 */
export interface ProductRecord {
  id: string;
  shopId: string;
  marketId: string;
  districtId: string;
  regionId: string;
  categoryId: string;
  categoryPath: string[];
  name: LocalizedText;
  description: LocalizedText | null;
  images: ProductImage[];
  unit: string;
  price: Money;
  oldPrice: Money | null;
  stockQty: Quantity;
  reservedQty: Quantity;
  availableQty: Quantity;
  minOrderQty: Quantity;
  stepQty: Quantity;
  maxOrderQty: Quantity | null;
  tolerancePercent: number;
  attributes: Record<string, unknown>;
  tags: string[];
  status: ProductStatus;
  moderationStatus: ModerationStatus;
  moderationReason: string | null;
  shopVisible: boolean;
  isVisible: boolean;
  visibilityReason: string;
  ratingAvg: number;
  ratingCount: number;
  ratingBayesian: number;
  salesCount: number;
  favoriteCount: number;
  slug: string;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toRecord(doc: ProductDoc): ProductRecord {
  const stock = Quantity.of(doc.stockQtyMilli, doc.unit);
  const reserved = Quantity.of(doc.reservedQtyMilli, doc.unit);
  return {
    id: doc._id.toString(),
    shopId: doc.shopId.toString(),
    marketId: doc.marketId.toString(),
    districtId: doc.districtId.toString(),
    regionId: doc.regionId.toString(),
    categoryId: doc.categoryId.toString(),
    categoryPath: doc.categoryPath.map((id) => id.toString()),
    name: doc.name,
    description: doc.description,
    images: doc.images,
    unit: doc.unit,
    price: Money.of(doc.price),
    oldPrice: doc.oldPrice === null ? null : Money.of(doc.oldPrice),
    stockQty: stock,
    reservedQty: reserved,
    availableQty: stock.subtract(reserved),
    minOrderQty: Quantity.of(doc.minOrderQtyMilli, doc.unit),
    stepQty: Quantity.of(doc.stepQtyMilli, doc.unit),
    maxOrderQty: doc.maxOrderQtyMilli === null ? null : Quantity.of(doc.maxOrderQtyMilli, doc.unit),
    tolerancePercent: doc.tolerancePercent,
    attributes: doc.attributes,
    tags: doc.tags,
    status: doc.status,
    moderationStatus: doc.moderationStatus,
    moderationReason: doc.moderationReason,
    shopVisible: doc.shopVisible,
    isVisible: doc.isVisible,
    visibilityReason: doc.visibilityReason,
    ratingAvg: doc.ratingAvg,
    ratingCount: doc.ratingCount,
    ratingBayesian: doc.ratingBayesian,
    salesCount: doc.salesCount,
    favoriteCount: doc.favoriteCount,
    slug: doc.slug,
    publishedAt: doc.publishedAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export interface CreateProductInput {
  shopId: string;
  marketId: string;
  districtId: string;
  regionId: string;
  categoryId: string;
  categoryPath: string[];
  name: LocalizedText;
  description: LocalizedText | null;
  images: ProductImage[];
  unit: string;
  price: Money;
  oldPrice: Money | null;
  stockQty: Quantity;
  minOrderQty: Quantity;
  stepQty: Quantity;
  maxOrderQty: Quantity | null;
  tolerancePercent: number;
  attributes: Record<string, unknown>;
  tags: string[];
  status: ProductStatus;
  shopVisible: boolean;
  slug: string;
}

export const productRepository = {
  async create(input: CreateProductInput, session: ClientSession): Promise<ProductRecord> {
    const [doc] = await ProductModel.create(
      [
        {
          shopId: new Types.ObjectId(input.shopId),
          marketId: new Types.ObjectId(input.marketId),
          districtId: new Types.ObjectId(input.districtId),
          regionId: new Types.ObjectId(input.regionId),
          categoryId: new Types.ObjectId(input.categoryId),
          categoryPath: input.categoryPath.map((id) => new Types.ObjectId(id)),
          name: input.name,
          description: input.description,
          images: input.images,
          unit: input.unit,
          price: input.price.minor,
          oldPrice: input.oldPrice?.minor ?? null,
          stockQtyMilli: input.stockQty.milli,
          minOrderQtyMilli: input.minOrderQty.milli,
          stepQtyMilli: input.stepQty.milli,
          maxOrderQtyMilli: input.maxOrderQty?.milli ?? null,
          tolerancePercent: input.tolerancePercent,
          attributes: input.attributes,
          tags: input.tags,
          status: input.status,
          shopVisible: input.shopVisible,
          slug: input.slug,
        },
      ],
      { session },
    );
    if (!doc) throw new Error('Product creation returned no document');
    return toRecord(doc.toObject<ProductDoc>());
  },

  async findById(id: string): Promise<ProductRecord | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const doc = await ProductModel.findOne({ _id: id, deletedAt: null }).lean<ProductDoc>();
    return doc ? toRecord(doc) : null;
  },

  async findByIdOrSlug(idOrSlug: string): Promise<ProductRecord | null> {
    const filter = Types.ObjectId.isValid(idOrSlug)
      ? { _id: idOrSlug, deletedAt: null }
      : { slug: idOrSlug.toLowerCase(), deletedAt: null };
    const doc = await ProductModel.findOne(filter).lean<ProductDoc>();
    return doc ? toRecord(doc) : null;
  },

  async list(parsed: ParsedQuery, extraFilter: Record<string, unknown> = {}): Promise<ProductRecord[]> {
    const base = { ...parsed.filter, ...extraFilter, deletedAt: null };
    const filter = parsed.cursorFilter ? { $and: [base, parsed.cursorFilter] } : base;
    const docs = await ProductModel.find(filter)
      .sort(parsed.sort)
      .limit(parsed.limit + 1)
      .lean<ProductDoc[]>();
    return docs.map(toRecord);
  },

  async slugExists(slug: string): Promise<boolean> {
    return (await ProductModel.countDocuments({ slug }).limit(1)) > 0;
  },

  async update(
    id: string,
    patch: Record<string, unknown>,
    session?: ClientSession,
  ): Promise<ProductRecord | null> {
    const doc = await ProductModel.findOneAndUpdate(
      { _id: id, deletedAt: null },
      { $set: patch },
      { new: true, runValidators: true, ...(session ? { session } : {}) },
    ).lean<ProductDoc>();
    return doc ? toRecord(doc) : null;
  },

  /**
   * Sets stock and derives the status in the same write.
   *
   * Keeping the two together removes the window in which stock is zero but the product still
   * says ACTIVE — a window a shopper would spend adding it to a cart.
   */
  async setStock(
    id: string,
    stock: Quantity,
    nextStatus: ProductStatus,
    session?: ClientSession,
  ): Promise<ProductRecord | null> {
    const doc = await ProductModel.findOneAndUpdate(
      { _id: id, deletedAt: null },
      { $set: { stockQtyMilli: stock.milli, status: nextStatus } },
      { new: true, runValidators: true, ...(session ? { session } : {}) },
    ).lean<ProductDoc>();
    return doc ? toRecord(doc) : null;
  },

  async recordPriceChange(
    input: { productId: string; shopId: string; price: Money; previousPrice: Money | null; changedBy: string },
    session?: ClientSession,
  ): Promise<void> {
    await ProductPriceHistoryModel.create(
      [
        {
          changedAt: new Date(),
          meta: {
            productId: new Types.ObjectId(input.productId),
            shopId: new Types.ObjectId(input.shopId),
          },
          price: input.price.minor,
          previousPrice: input.previousPrice?.minor ?? null,
          changedBy: new Types.ObjectId(input.changedBy),
        },
      ],
      // Time-series collections cannot join a multi-document transaction, so history is
      // written outside it. Losing a history row is cosmetic; losing the price change is not.
      session ? {} : {},
    );
  },

  async priceHistory(productId: string, since: Date): Promise<Array<{ price: Money; at: Date }>> {
    const docs = await ProductPriceHistoryModel.find({
      'meta.productId': new Types.ObjectId(productId),
      changedAt: { $gte: since },
    })
      .sort({ changedAt: 1 })
      .lean<Array<{ price: bigint; changedAt: Date }>>();
    return docs.map((doc) => ({ price: Money.of(doc.price), at: doc.changedAt }));
  },

  async softDelete(id: string, session: ClientSession): Promise<boolean> {
    const result = await ProductModel.updateOne(
      { _id: id, deletedAt: null },
      { $set: { deletedAt: new Date(), isVisible: false, visibilityReason: 'NOT_ACTIVE' } },
      { session },
    );
    return result.modifiedCount === 1;
  },

  /**
   * Cascades a shop's visibility onto its products.
   *
   * One `updateMany` rather than a loop: a seller with two thousand products must not become
   * two thousand round trips when their wallet runs dry. Correct because shop visibility is
   * the only input that changed, so the outcome is identical for every product whose own
   * status already permitted it.
   */
  async cascadeShopVisibility(
    shopId: string,
    shopVisible: boolean,
  ): Promise<{ shown: number; hidden: number }> {
    const now = new Date();
    if (!shopVisible) {
      const hidden = await ProductModel.updateMany(
        { shopId, deletedAt: null },
        {
          $set: {
            shopVisible: false,
            isVisible: false,
            visibilityReason: 'SHOP_NOT_VISIBLE',
            visibilityComputedAt: now,
          },
        },
      );
      return { shown: 0, hidden: hidden.modifiedCount };
    }

    // Turning a shop back on must not blanket-publish: each product's own status and
    // moderation still apply, so only those already eligible become visible.
    await ProductModel.updateMany(
      { shopId, deletedAt: null },
      { $set: { shopVisible: true, visibilityComputedAt: now } },
    );
    const shown = await ProductModel.updateMany(
      {
        shopId,
        deletedAt: null,
        status: { $in: ['ACTIVE', 'OUT_OF_STOCK'] },
        moderationStatus: 'APPROVED',
      },
      { $set: { isVisible: true, visibilityReason: 'VISIBLE', visibilityComputedAt: now } },
    );
    return { shown: shown.modifiedCount, hidden: 0 };
  },

  async countForShop(shopId: string): Promise<number> {
    return ProductModel.countDocuments({ shopId, deletedAt: null });
  },

  async countByCategory(categoryId: string): Promise<number> {
    return ProductModel.countDocuments({ categoryPath: categoryId, deletedAt: null });
  },

  /** Buffered view counter; flushed by the caller rather than written per request. */
  async incrementViews(id: string, by: number): Promise<void> {
    await ProductModel.updateOne({ _id: id }, { $inc: { viewCount: by } });
  },
};
