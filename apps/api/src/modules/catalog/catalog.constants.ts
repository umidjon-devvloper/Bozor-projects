export const ProductStatus = {
  DRAFT: 'DRAFT',
  PENDING_MODERATION: 'PENDING_MODERATION',
  ACTIVE: 'ACTIVE',
  OUT_OF_STOCK: 'OUT_OF_STOCK',
  ARCHIVED: 'ARCHIVED',
} as const;
export type ProductStatus = (typeof ProductStatus)[keyof typeof ProductStatus];

/** Statuses that count as "live" for visibility. Out of stock is still on the shelf. */
export const LIVE_PRODUCT_STATUSES: readonly ProductStatus[] = [
  ProductStatus.ACTIVE,
  ProductStatus.OUT_OF_STOCK,
];

export const PRODUCT_TRANSITIONS: Readonly<Record<ProductStatus, readonly ProductStatus[]>> = {
  DRAFT: [ProductStatus.PENDING_MODERATION, ProductStatus.ARCHIVED],
  PENDING_MODERATION: [ProductStatus.ACTIVE, ProductStatus.DRAFT, ProductStatus.ARCHIVED],
  ACTIVE: [ProductStatus.OUT_OF_STOCK, ProductStatus.PENDING_MODERATION, ProductStatus.ARCHIVED],
  OUT_OF_STOCK: [ProductStatus.ACTIVE, ProductStatus.PENDING_MODERATION, ProductStatus.ARCHIVED],
  // Archiving is final. Historical orders still render from their line snapshots, so a
  // resurrected product would create two products with one history.
  ARCHIVED: [],
};

export const AttributeType = {
  STRING: 'STRING',
  NUMBER: 'NUMBER',
  BOOLEAN: 'BOOLEAN',
  ENUM: 'ENUM',
} as const;
export type AttributeType = (typeof AttributeType)[keyof typeof AttributeType];

export const MAX_CATEGORY_DEPTH = 4;
export const MAX_PRODUCT_IMAGES = 10;
export const MAX_PRODUCT_TAGS = 20;

/**
 * Fields whose change sends a product back to moderation.
 *
 * Price and stock are deliberately absent. Bazaar prices move daily and stock moves hourly;
 * putting either behind human review would make the platform unusable and the queue
 * meaningless (MODERATION.md).
 */
export const REMODERATION_FIELDS: readonly string[] = ['name', 'description', 'images', 'categoryId'];

/** Default handover tolerance for weighed goods when a category declares none (ADR-0006). */
export const DEFAULT_TOLERANCE_BP = 1000;

/** Bayesian prior for rating sort: assume this many reviews at this rating (×100). */
export const RATING_PRIOR_COUNT = 20;
export const RATING_PRIOR_VALUE = 400;
