import { Router, type RequestHandler } from 'express';
import { ProductSearchQuerySchema, ShopSearchQuerySchema, SuggestQuerySchema } from '@bozorlar/contracts';
import { validateQuery } from '../../../middleware/validate.js';
import { byUser, rateLimit } from '../../../middleware/rateLimit.js';
import { requirePermission } from '../../../middleware/permission.js';
import { asyncHandler } from '../../../shared/asyncHandler.js';
import { Permission } from '../../authz/index.js';
import type { SearchController } from './search.controller.js';

export function createSearchRouter(controller: SearchController): Router {
  const router = Router();

  router.get(
    '/products',
    rateLimit({ name: 'search:products', limit: 120, windowSeconds: 60 }),
    validateQuery(ProductSearchQuerySchema),
    asyncHandler(controller.products),
  );
  router.get(
    '/shops',
    rateLimit({ name: 'search:shops', limit: 120, windowSeconds: 60 }),
    validateQuery(ShopSearchQuerySchema),
    asyncHandler(controller.shops),
  );
  router.get(
    '/suggest',
    // Fires on every keystroke the client does not debounce, so the ceiling is high but real.
    rateLimit({ name: 'search:suggest', limit: 600, windowSeconds: 60 }),
    validateQuery(SuggestQuerySchema),
    asyncHandler(controller.suggest),
  );

  return router;
}

export function createSearchAdminRouter(
  controller: SearchController,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  router.use(authenticate);

  router.get(
    '/search/health',
    rateLimit({ name: 'admin:search-health', limit: 60, windowSeconds: 60, keyResolver: byUser }),
    requirePermission(Permission.SEARCH_REINDEX),
    asyncHandler(controller.health),
  );
  router.post(
    '/search/reindex',
    // A full rebuild reads the whole catalogue; twice an hour is generous for an operation
    // that should be rare.
    rateLimit({ name: 'admin:search-reindex', limit: 2, windowSeconds: 3600, keyResolver: byUser }),
    requirePermission(Permission.SEARCH_REINDEX),
    asyncHandler(controller.reindex),
  );

  return router;
}
