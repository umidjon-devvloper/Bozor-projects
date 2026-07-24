import { Router, type RequestHandler } from 'express';
import {
  CreateReviewRequestSchema,
  ModerateReviewRequestSchema,
  ReplyToReviewRequestSchema,
  ReportReviewRequestSchema,
} from '@bozorlar/contracts';
import { validateBody } from '../../../middleware/validate.js';
import { byUser, rateLimit } from '../../../middleware/rateLimit.js';
import { requirePermission } from '../../../middleware/permission.js';
import { asyncHandler } from '../../../shared/asyncHandler.js';
import { Permission } from '../../authz/index.js';
import type { ReviewController } from './review.controller.js';

/** Public read paths, mounted alongside the catalogue they belong to. */
export function createPublicReviewRouter(controller: ReviewController): Router {
  const router = Router();
  const publicRead = rateLimit({ name: 'reviews:read', limit: 300, windowSeconds: 60 });

  router.get('/products/:id/reviews', publicRead, asyncHandler(controller.listForProduct));
  router.get('/products/:id/reviews/summary', publicRead, asyncHandler(controller.productSummary));
  router.get('/shops/:id/reviews', publicRead, asyncHandler(controller.listForShop));
  router.get('/shops/:id/reviews/summary', publicRead, asyncHandler(controller.shopSummary));
  return router;
}

export function createReviewRouter(
  controller: ReviewController,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  router.use(authenticate);

  router.post(
    '/',
    // A review costs a completed order to earn, so the ceiling only needs to stop scripting.
    rateLimit({ name: 'reviews:create', limit: 30, windowSeconds: 3600, keyResolver: byUser }),
    requirePermission(Permission.REVIEW_CREATE_OWN),
    validateBody(CreateReviewRequestSchema),
    asyncHandler(controller.create),
  );
  router.delete(
    '/:id',
    rateLimit({ name: 'reviews:withdraw', limit: 20, windowSeconds: 3600, keyResolver: byUser }),
    requirePermission(Permission.REVIEW_CREATE_OWN),
    asyncHandler(controller.withdraw),
  );
  router.post(
    '/:id/report',
    // Tight: reporting is the lever an attacker would pull to bury a competitor's review.
    rateLimit({ name: 'reviews:report', limit: 20, windowSeconds: 3600, keyResolver: byUser }),
    requirePermission(Permission.REVIEW_CREATE_OWN),
    validateBody(ReportReviewRequestSchema),
    asyncHandler(controller.report),
  );
  router.post(
    '/:id/reply',
    rateLimit({ name: 'reviews:reply', limit: 120, windowSeconds: 3600, keyResolver: byUser }),
    requirePermission(Permission.REVIEW_REPLY_OWN_SHOP),
    validateBody(ReplyToReviewRequestSchema),
    asyncHandler(controller.reply),
  );

  return router;
}

export function createReviewAdminRouter(
  controller: ReviewController,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  router.use(authenticate);
  const limited = rateLimit({ name: 'admin:reviews', limit: 300, windowSeconds: 60, keyResolver: byUser });

  router.post(
    '/reviews/:id/moderate',
    limited,
    requirePermission(Permission.REVIEW_MODERATE),
    validateBody(ModerateReviewRequestSchema),
    asyncHandler(controller.moderate),
  );
  router.get(
    '/reviews/aggregates/:type/:id',
    limited,
    requirePermission(Permission.REVIEW_MODERATE),
    asyncHandler(controller.reconcile),
  );
  router.post(
    '/reviews/aggregates/:type/:id/repair',
    rateLimit({ name: 'admin:review-repair', limit: 20, windowSeconds: 3600, keyResolver: byUser }),
    requirePermission(Permission.REVIEW_MODERATE),
    asyncHandler(controller.repair),
  );

  return router;
}
