import { Router, type RequestHandler } from 'express';
import { RejectApplicationRequestSchema, SubmitApplicationRequestSchema } from '@bozorlar/contracts';
import { validateBody } from '../../../middleware/validate.js';
import { byUser, rateLimit } from '../../../middleware/rateLimit.js';
import { requirePermission } from '../../../middleware/permission.js';
import { asyncHandler } from '../../../shared/asyncHandler.js';
import { Permission } from '../../authz/index.js';
import type { OnboardingController } from './onboarding.controller.js';

/** Applicant-facing routes, mounted under /api/v1/seller/applications. */
export function createApplicationRouter(
  controller: OnboardingController,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  router.use(authenticate);

  router.post(
    '/',
    // Deliberately tight: each submission costs a moderator's time, and the volume a
    // legitimate applicant needs is one.
    rateLimit({ name: 'onboarding:submit', limit: 3, windowSeconds: 86_400, keyResolver: byUser }),
    requirePermission(Permission.ONBOARDING_APPLY),
    validateBody(SubmitApplicationRequestSchema),
    asyncHandler(controller.submit),
  );

  router.get(
    '/me',
    rateLimit({ name: 'onboarding:read', limit: 60, windowSeconds: 60, keyResolver: byUser }),
    requirePermission(Permission.ONBOARDING_READ_OWN),
    asyncHandler(controller.getMine),
  );

  router.patch(
    '/:id',
    rateLimit({ name: 'onboarding:resubmit', limit: 5, windowSeconds: 86_400, keyResolver: byUser }),
    requirePermission(Permission.ONBOARDING_APPLY),
    validateBody(SubmitApplicationRequestSchema),
    asyncHandler(controller.resubmit),
  );

  router.post(
    '/:id/withdraw',
    rateLimit({ name: 'onboarding:withdraw', limit: 10, windowSeconds: 86_400, keyResolver: byUser }),
    requirePermission(Permission.ONBOARDING_READ_OWN),
    asyncHandler(controller.withdraw),
  );

  return router;
}

/** Moderation routes, mounted under /api/v1/admin/seller-applications. */
export function createApplicationAdminRouter(
  controller: OnboardingController,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  router.use(authenticate);
  const limited = rateLimit({ name: 'admin:onboarding', limit: 300, windowSeconds: 60, keyResolver: byUser });

  router.get('/', limited, requirePermission(Permission.ONBOARDING_READ_ALL), asyncHandler(controller.list));
  router.get('/:id', limited, requirePermission(Permission.ONBOARDING_READ_ALL), asyncHandler(controller.get));

  // Its own permission, checked again inside the controller, and audited at CRITICAL.
  router.get(
    '/:id/identity',
    rateLimit({ name: 'admin:onboarding:identity', limit: 60, windowSeconds: 3600, keyResolver: byUser }),
    requirePermission(Permission.ONBOARDING_REVEAL_IDENTITY),
    asyncHandler(controller.revealIdentity),
  );

  router.post('/:id/claim', limited, requirePermission(Permission.ONBOARDING_REVIEW), asyncHandler(controller.claim));
  router.post('/:id/approve', limited, requirePermission(Permission.ONBOARDING_REVIEW), asyncHandler(controller.approve));
  router.post(
    '/:id/reject',
    limited,
    requirePermission(Permission.ONBOARDING_REVIEW),
    validateBody(RejectApplicationRequestSchema),
    asyncHandler(controller.reject),
  );

  return router;
}
