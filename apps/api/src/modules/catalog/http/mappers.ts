import { resolveLocalized, type Locale, type LocalizedText } from '@bozorlar/types';
import type { CategoryNode } from '../services/category.service.js';
import type { CategoryRecord, UnitRecord } from '../repositories/catalogReference.repository.js';
import type { ProductView } from '../services/product.service.js';

export interface ViewOptions {
  locale: Locale;
  raw: boolean;
  /** Shop members and moderators see status, moderation and true stock. */
  privileged: boolean;
  cdnBaseUrl: string;
}

function text<T extends LocalizedText | null>(
  value: T,
  options: ViewOptions,
): string | LocalizedText | null {
  if (value === null) return null;
  return options.raw ? value : resolveLocalized(value, options.locale);
}

export function toUnitResponse(unit: UnitRecord, options: ViewOptions) {
  return {
    code: unit.code,
    name: text(unit.name, options),
    shortName: text(unit.shortName, options),
    decimalPlaces: unit.decimalPlaces,
    allowsAdjustment: unit.allowsAdjustment,
  };
}

export function toCategoryResponse(category: CategoryRecord, options: ViewOptions) {
  return {
    id: category.id,
    slug: category.slug,
    name: text(category.name, options),
    description: text(category.description, options),
    icon: category.icon,
    parentId: category.parentId,
    depth: category.depth,
    path: category.ancestors.map((ancestor) => ({
      id: ancestor.id,
      slug: ancestor.slug,
      name: text(ancestor.name, options),
    })),
    defaultUnit: category.defaultUnit,
    allowedUnits: category.allowedUnits,
    defaultTolerancePercent: category.defaultTolerancePercent,
    attributes: category.attributeSchema.map((attribute) => ({
      key: attribute.key,
      type: attribute.type,
      name: text(attribute.name, options),
      options: attribute.options,
      required: attribute.required,
    })),
    productCount: category.productCount,
  };
}

export function toCategoryTreeResponse(nodes: CategoryNode[], options: ViewOptions): unknown[] {
  return nodes.map((node) => ({
    ...toCategoryResponse(node, options),
    children: toCategoryTreeResponse(node.children, options),
  }));
}

/**
 * Product serializer.
 *
 * Money and quantity leave as strings of integer minor units (ADR-0028) — a client that
 * wants to render them must go through the shared `Money` type rather than doing float
 * arithmetic on the way to the screen.
 */
export function toProductResponse(product: ProductView, options: ViewOptions) {
  const imageUrl = (key: string): string => `${options.cdnBaseUrl.replace(/\/$/, '')}/${key}`;
  return {
    id: product.id,
    slug: product.slug,
    name: text(product.name, options),
    description: text(product.description, options),
    images: product.images.map((image) => ({
      url: imageUrl(image.mediaKey),
      thumbUrl: imageUrl(image.mediaKey.replace(/\.[^./]+$/, '_thumb.webp')),
      cardUrl: imageUrl(image.mediaKey.replace(/\.[^./]+$/, '_card.webp')),
      width: image.width,
      height: image.height,
      blurhash: image.blurhash,
    })),
    shopId: product.shopId,
    marketId: product.marketId,
    categoryId: product.categoryId,
    unit: product.unit,
    price: product.price.toDTO(),
    oldPrice: product.oldPrice?.toDTO() ?? null,
    discountPercent: product.discountPercent,
    availableQty: product.availableQty.toDTO(),
    minOrderQty: product.minOrderQty.toDTO(),
    stepQty: product.stepQty.toDTO(),
    maxOrderQty: product.maxOrderQty?.toDTO() ?? null,
    tolerancePercent: product.tolerancePercent,
    inStock: product.availableQty.milli >= product.minOrderQty.milli,
    isPurchasable: product.isPurchasable,
    attributes: product.attributes,
    tags: product.tags,
    rating: { avg: product.ratingAvg / 100, count: product.ratingCount },
    salesCount: product.salesCount,
    favoriteCount: product.favoriteCount,
    createdAt: product.createdAt.toISOString(),
    ...(options.privileged
      ? {
          status: product.status,
          moderationStatus: product.moderationStatus,
          moderationReason: product.moderationReason,
          isVisible: product.isVisible,
          visibilityReason: product.visibilityReason,
          // True stock, not availability: only the seller needs to see what is reserved.
          stockQty: product.stockQty.toDTO(),
          reservedQty: product.reservedQty.toDTO(),
          publishedAt: product.publishedAt?.toISOString() ?? null,
        }
      : {}),
  };
}
