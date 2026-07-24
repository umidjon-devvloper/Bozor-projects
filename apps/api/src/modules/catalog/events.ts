/**
 * Catalog domain events (EVENTS.md).
 *
 * RECONSTRUCTED during repository recovery. Every constant name is proved by a call site in
 * `product.service.ts`, and every wire string is proved by a subscriber: the worker's
 * `searchIndexHandlers` and `shopVisibilityHandler`, and the notification templates.
 */
export const CatalogEvents = {
  PRODUCT_CREATED: 'product.created',
  PRODUCT_UPDATED: 'product.updated',
  PRODUCT_ARCHIVED: 'product.archived',
  PRODUCT_PRICE_CHANGED: 'product.price_changed',
  PRODUCT_STOCK_CHANGED: 'product.stock_changed',
  PRODUCT_MODERATION_DECIDED: 'product.moderation_decided',
} as const;

export type CatalogEvent = (typeof CatalogEvents)[keyof typeof CatalogEvents];
