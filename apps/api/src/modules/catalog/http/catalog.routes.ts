import { Router, type RequestHandler } from 'express';
import {
  CreateCategoryRequestSchema,
  CreateProductRequestSchema,
  ModerateProductRequestSchema,
  PriceHistoryQuerySchema,
  SetPriceRequestSchema,
  SetStockRequestSchema,
  UpdateCategoryRequestSchema,
  UpdateProductRequestSchema,
} from '@bozorlar/contracts';
import { validateBody, validateQuery } from '../../../middleware/validate.js';
import { byUser, rateLimit } from '../../../middleware/rateLimit.js';
import { requirePermission } from '../../../middleware/permission.js';
import { asyncHandler } from '../../../shared/asyncHandler.js';
import { Permission } from '../../authz/index.js';
import type { CatalogController } from './catalog.controller.js';

export function createCatalogRouter(
  controller: CatalogController,
  middleware: { optionalAuth: RequestHandler },
): Router {
  const router = Router();
  const publicRead = rateLimit({ name: 'catalog:read', limit: 300, windowSeconds: 60 });

  router.get('/units', publicRead, asyncHandler(controller.units));
  router.get('/categories/tree', publicRead, asyncHandler(controller.categoryTree));
  router.get('/categories/:idOrSlug', publicRead, asyncHandler(controller.category));

  router.get('/products', publicRead, middleware.optionalAuth, asyncHandler(controller.listProducts));
  // Registered before the slug route so "…/price-history" is never captured as a slug.
  router.get(
    '/products/:id/price-history',
    publicRead,
    validateQuery(PriceHistoryQuerySchema),
    asyncHandler(controller.priceHistory),
  );
  router.get(
    '/products/:idOrSlug',
    publicRead,
    middleware.optionalAuth,
    asyncHandler(controller.getProduct),
  );

  return router;
}

export function createSellerProductRouter(
  controller: CatalogController,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  router.use(authenticate);
  const limited = rateLimit({ name: 'seller:products', limit: 120, windowSeconds: 60, keyResolver: byUser });

  router.get('/', limited, requirePermission(Permission.PRODUCT_READ), asyncHandler(controller.listMyProducts));
  router.post(
    '/',
    rateLimit({ name: 'seller:product-create', limit: 100, windowSeconds: 3600, keyResolver: byUser }),
    requirePermission(Permission.PRODUCT_CREATE_OWN_SHOP),
    validateBody(CreateProductRequestSchema),
    asyncHandler(controller.createProduct),
  );
  router.get('/:id', limited, requirePermission(Permission.PRODUCT_READ), asyncHandler(controller.getMyProduct));
  router.patch(
    '/:id',
    limited,
    requirePermission(Permission.PRODUCT_UPDATE_OWN_SHOP),
    validateBody(UpdateProductRequestSchema),
    asyncHandler(controller.updateProduct),
  );
  // Price and stock get their own generous limits: a seller repricing a whole stall in the
  // morning is normal behaviour, not abuse.
  router.patch(
    '/:id/price',
    rateLimit({ name: 'seller:price', limit: 600, windowSeconds: 3600, keyResolver: byUser }),
    requirePermission(Permission.PRODUCT_UPDATE_OWN_SHOP),
    validateBody(SetPriceRequestSchema),
    asyncHandler(controller.setPrice),
  );
  router.patch(
    '/:id/stock',
    rateLimit({ name: 'seller:stock', limit: 1200, windowSeconds: 3600, keyResolver: byUser }),
    requirePermission(Permission.PRODUCT_UPDATE_OWN_SHOP),
    validateBody(SetStockRequestSchema),
    asyncHandler(controller.setStock),
  );
  router.delete(
    '/:id',
    limited,
    requirePermission(Permission.PRODUCT_DELETE_OWN_SHOP),
    asyncHandler(controller.archiveProduct),
  );

  return router;
}

export function createCatalogAdminRouter(
  controller: CatalogController,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  router.use(authenticate);
  const limited = rateLimit({ name: 'admin:catalog', limit: 300, windowSeconds: 60, keyResolver: byUser });

  router.post(
    '/categories',
    limited,
    requirePermission(Permission.CATEGORY_MANAGE),
    validateBody(CreateCategoryRequestSchema),
    asyncHandler(controller.createCategory),
  );
  router.patch(
    '/categories/:id',
    limited,
    requirePermission(Permission.CATEGORY_MANAGE),
    validateBody(UpdateCategoryRequestSchema),
    asyncHandler(controller.updateCategory),
  );
  router.delete(
    '/categories/:id',
    limited,
    requirePermission(Permission.CATEGORY_MANAGE),
    asyncHandler(controller.deactivateCategory),
  );
  router.post(
    '/products/:id/moderate',
    limited,
    requirePermission(Permission.PRODUCT_MODERATE),
    validateBody(ModerateProductRequestSchema),
    asyncHandler(controller.moderateProduct),
  );

  return router;
}
