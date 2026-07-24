/**
 * Public surface of the catalog module (ADR-0011 rule 1).
 *
 * `cascadeShopVisibility` is consumed by the worker when a shop appears or disappears;
 * everything else stays internal.
 */
export type { ProductRecord } from './repositories/product.repository.js';
export {
  createProductService,
  type ProductService,
  type ProductView,
  type ShopLookup,
  type ShopContext,
  type CreateProductCommand,
} from './services/product.service.js';
export { createCategoryService, type CategoryService, type CategoryNode } from './services/category.service.js';
export { createCatalogController, type CatalogController } from './http/catalog.controller.js';
export {
  createCatalogRouter,
  createSellerProductRouter,
  createCatalogAdminRouter,
} from './http/catalog.routes.js';
export {
  ProductStatus,
  PRODUCT_TRANSITIONS,
  LIVE_PRODUCT_STATUSES,
  AttributeType,
  REMODERATION_FIELDS,
} from './catalog.constants.js';
export { validateAttributes, mergeAttributeSchemas } from './services/attributes.service.js';
export { CatalogEvents } from './events.js';
