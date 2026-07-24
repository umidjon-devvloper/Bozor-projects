import { Router, type RequestHandler } from 'express';
import {
  AddFavouriteRequestSchema,
  FavouriteStatusQuerySchema,
  ListFavouritesQuerySchema,
  SetFavouriteAlertsRequestSchema,
} from '@bozorlar/contracts';
import { validateBody, validateQuery } from '../../../middleware/validate.js';
import { byUser, rateLimit } from '../../../middleware/rateLimit.js';
import { requirePermission } from '../../../middleware/permission.js';
import { asyncHandler } from '../../../shared/asyncHandler.js';
import { Permission } from '../../authz/index.js';
import type { FavouriteController } from './favourite.controller.js';

/**
 * Everything here is personal, so everything is authenticated. There is no public favourites
 * endpoint by design: who follows what is not a fact the platform publishes.
 */
export function createFavouriteRouter(
  controller: FavouriteController,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  router.use(authenticate);

  const read = rateLimit({ name: 'favourites:read', limit: 300, windowSeconds: 60, keyResolver: byUser });
  // Generous: adding favourites while browsing is normal, and the per-user ceiling in the
  // service is what actually bounds the data. This only stops scripting.
  const write = rateLimit({ name: 'favourites:write', limit: 240, windowSeconds: 3600, keyResolver: byUser });

  router.post(
    '/',
    write,
    requirePermission(Permission.FAVOURITE_MANAGE_OWN),
    validateBody(AddFavouriteRequestSchema),
    asyncHandler(controller.add),
  );
  router.get(
    '/products',
    read,
    requirePermission(Permission.FAVOURITE_MANAGE_OWN),
    validateQuery(ListFavouritesQuerySchema),
    asyncHandler(controller.listProducts),
  );
  router.get(
    '/shops',
    read,
    requirePermission(Permission.FAVOURITE_MANAGE_OWN),
    validateQuery(ListFavouritesQuerySchema),
    asyncHandler(controller.listShops),
  );
  router.get(
    '/status',
    read,
    requirePermission(Permission.FAVOURITE_MANAGE_OWN),
    validateQuery(FavouriteStatusQuerySchema),
    asyncHandler(controller.status),
  );
  router.patch(
    '/products/:productId/alerts',
    write,
    requirePermission(Permission.FAVOURITE_MANAGE_OWN),
    validateBody(SetFavouriteAlertsRequestSchema),
    asyncHandler(controller.setAlerts),
  );
  router.delete(
    '/:targetType/:targetId',
    write,
    requirePermission(Permission.FAVOURITE_MANAGE_OWN),
    asyncHandler(controller.remove),
  );

  return router;
}

/**
 * The seller's view of demand: how many people follow a product, and how many of them are
 * waiting for it to come back. Scoped to the seller's own shops in the service.
 */
export function createSellerFavouriteRouter(
  controller: FavouriteController,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  router.use(authenticate);

  router.get(
    '/products/:id/favourites',
    rateLimit({ name: 'seller:favourites', limit: 300, windowSeconds: 60, keyResolver: byUser }),
    requirePermission(Permission.FAVOURITE_READ_OWN_SHOP),
    asyncHandler(controller.sellerCounts),
  );

  return router;
}
