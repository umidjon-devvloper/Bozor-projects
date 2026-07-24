import { Router, type RequestHandler } from 'express';
import {
  AddShopMemberRequestSchema,
  CreateMarketRequestSchema,
  CreateShopRequestSchema,
  ModerateShopRequestSchema,
  NearbyQuerySchema,
  SetMarketStatusRequestSchema,
  SetShopVacationRequestSchema,
  SetShopWorkingHoursRequestSchema,
  UpdateMarketRequestSchema,
  UpdateShopRequestSchema,
} from '@bozorlar/contracts';
import { validateBody, validateQuery } from '../../../middleware/validate.js';
import { byUser, rateLimit } from '../../../middleware/rateLimit.js';
import { requirePermission } from '../../../middleware/permission.js';
import { asyncHandler } from '../../../shared/asyncHandler.js';
import { Permission } from '../../authz/index.js';
import type { GeoController } from './geo.controller.js';

/**
 * Route wiring. Rate limits and cache policy sit next to the route they govern so a reviewer
 * sees the endpoint and its protections together (API.md Part 7).
 */
export function createGeoRouter(
  controller: GeoController,
  middleware: { authenticate: RequestHandler; optionalAuth: RequestHandler },
): Router {
  const router = Router();
  const publicRead = rateLimit({ name: 'geo:read', limit: 300, windowSeconds: 60 });

  router.get('/geo/regions', publicRead, asyncHandler(controller.listRegions));
  router.get('/geo/regions/:id/districts', publicRead, asyncHandler(controller.listDistricts));

  router.get('/markets', publicRead, asyncHandler(controller.listMarkets));
  // Registered before /markets/:idOrSlug so "nearby" is never captured as a slug.
  router.get(
    '/markets/nearby',
    rateLimit({ name: 'geo:nearby', limit: 60, windowSeconds: 60 }),
    validateQuery(NearbyQuerySchema),
    asyncHandler(controller.nearbyMarkets),
  );
  router.get('/markets/:idOrSlug', publicRead, asyncHandler(controller.getMarket));
  router.get(
    '/markets/:id/shops',
    publicRead,
    middleware.optionalAuth,
    asyncHandler(controller.listMarketShops),
  );

  router.get('/shops', publicRead, middleware.optionalAuth, asyncHandler(controller.listShops));
  router.get(
    '/shops/:idOrSlug',
    publicRead,
    middleware.optionalAuth,
    asyncHandler(controller.getShop),
  );

  return router;
}

export function createSellerShopRouter(
  controller: GeoController,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  router.use(authenticate);
  const limited = rateLimit({ name: 'seller:shops', limit: 120, windowSeconds: 60, keyResolver: byUser });

  router.get('/', limited, requirePermission(Permission.SHOP_READ_OWN), asyncHandler(controller.listMyShops));
  router.post(
    '/',
    rateLimit({ name: 'seller:shop-create', limit: 5, windowSeconds: 3600, keyResolver: byUser }),
    requirePermission(Permission.SHOP_CREATE),
    validateBody(CreateShopRequestSchema),
    asyncHandler(controller.createShop),
  );
  router.get('/:id', limited, requirePermission(Permission.SHOP_READ_OWN), asyncHandler(controller.getMyShop));
  router.patch(
    '/:id',
    limited,
    requirePermission(Permission.SHOP_UPDATE_OWN),
    validateBody(UpdateShopRequestSchema),
    asyncHandler(controller.updateShop),
  );
  router.patch(
    '/:id/working-hours',
    limited,
    requirePermission(Permission.SHOP_UPDATE_OWN),
    validateBody(SetShopWorkingHoursRequestSchema),
    asyncHandler(controller.setWorkingHours),
  );
  router.post(
    '/:id/vacation',
    limited,
    requirePermission(Permission.SHOP_UPDATE_OWN),
    validateBody(SetShopVacationRequestSchema),
    asyncHandler(controller.setVacation),
  );
  router.post(
    '/:id/members',
    limited,
    requirePermission(Permission.SHOP_MEMBERS_MANAGE),
    validateBody(AddShopMemberRequestSchema),
    asyncHandler(controller.addMember),
  );
  router.delete(
    '/:id/members/:userId',
    limited,
    requirePermission(Permission.SHOP_MEMBERS_MANAGE),
    asyncHandler(controller.removeMember),
  );
  router.delete(
    '/:id',
    limited,
    requirePermission(Permission.SHOP_DELETE_OWN),
    asyncHandler(controller.closeShop),
  );

  return router;
}

export function createGeoAdminRouter(
  controller: GeoController,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  router.use(authenticate);
  const limited = rateLimit({ name: 'admin:geo', limit: 300, windowSeconds: 60, keyResolver: byUser });

  router.post(
    '/markets',
    limited,
    requirePermission(Permission.MARKET_MANAGE),
    validateBody(CreateMarketRequestSchema),
    asyncHandler(controller.createMarket),
  );
  router.patch(
    '/markets/:id',
    limited,
    requirePermission(Permission.MARKET_MANAGE),
    validateBody(UpdateMarketRequestSchema),
    asyncHandler(controller.updateMarket),
  );
  router.post(
    '/markets/:id/status',
    limited,
    requirePermission(Permission.MARKET_MANAGE),
    validateBody(SetMarketStatusRequestSchema),
    asyncHandler(controller.setMarketStatus),
  );
  router.post(
    '/shops/:id/moderate',
    limited,
    requirePermission(Permission.SHOP_MODERATE),
    validateBody(ModerateShopRequestSchema),
    asyncHandler(controller.moderateShop),
  );

  return router;
}
