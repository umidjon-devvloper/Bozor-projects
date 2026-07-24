import { Router, type RequestHandler } from 'express';
import {
  DisputeMessageRequestSchema,
  RaiseDisputeRequestSchema,
  ResolveDisputeRequestSchema,
} from '@bozorlar/contracts';
import { validateBody } from '../../../middleware/validate.js';
import { byUser, rateLimit } from '../../../middleware/rateLimit.js';
import { requirePermission } from '../../../middleware/permission.js';
import { asyncHandler } from '../../../shared/asyncHandler.js';
import { Permission } from '../../authz/index.js';
import type { DisputeController } from './dispute.controller.js';

export function createDisputeRouter(
  controller: DisputeController,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  router.use(authenticate);
  const limited = rateLimit({ name: 'disputes', limit: 60, windowSeconds: 60, keyResolver: byUser });

  router.post(
    '/',
    // Each dispute costs a moderator's attention, so the ceiling is deliberately low.
    rateLimit({ name: 'disputes:raise', limit: 5, windowSeconds: 86_400, keyResolver: byUser }),
    requirePermission(Permission.DISPUTE_RAISE_OWN),
    validateBody(RaiseDisputeRequestSchema),
    asyncHandler(controller.raise),
  );
  router.get('/', limited, requirePermission(Permission.DISPUTE_RAISE_OWN), asyncHandler(controller.listMine));
  router.get('/:id', limited, requirePermission(Permission.DISPUTE_RAISE_OWN), asyncHandler(controller.get));
  router.post(
    '/:id/messages',
    rateLimit({ name: 'disputes:message', limit: 30, windowSeconds: 3600, keyResolver: byUser }),
    requirePermission(Permission.DISPUTE_RAISE_OWN),
    validateBody(DisputeMessageRequestSchema),
    asyncHandler(controller.addMessage),
  );
  router.post(
    '/:id/withdraw',
    limited,
    requirePermission(Permission.DISPUTE_RAISE_OWN),
    asyncHandler(controller.withdraw),
  );

  return router;
}

export function createSellerDisputeRouter(
  controller: DisputeController,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  router.use(authenticate);
  const limited = rateLimit({ name: 'seller:disputes', limit: 120, windowSeconds: 60, keyResolver: byUser });

  router.get('/', limited, requirePermission(Permission.DISPUTE_RESPOND_OWN_SHOP), asyncHandler(controller.listForShop));
  router.get('/:id', limited, requirePermission(Permission.DISPUTE_RESPOND_OWN_SHOP), asyncHandler(controller.get));
  router.post(
    '/:id/respond',
    rateLimit({ name: 'seller:dispute-respond', limit: 60, windowSeconds: 3600, keyResolver: byUser }),
    requirePermission(Permission.DISPUTE_RESPOND_OWN_SHOP),
    validateBody(DisputeMessageRequestSchema),
    asyncHandler(controller.respond),
  );

  return router;
}

export function createDisputeAdminRouter(
  controller: DisputeController,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  router.use(authenticate);
  const limited = rateLimit({ name: 'admin:disputes', limit: 300, windowSeconds: 60, keyResolver: byUser });

  router.get('/disputes', limited, requirePermission(Permission.DISPUTE_READ_ALL), asyncHandler(controller.queue));
  router.get('/disputes/:id', limited, requirePermission(Permission.DISPUTE_READ_ALL), asyncHandler(controller.get));
  router.post(
    '/disputes/:id/resolve',
    // Moves money and marks a seller's record; audited at CRITICAL either way.
    rateLimit({ name: 'admin:dispute-resolve', limit: 60, windowSeconds: 3600, keyResolver: byUser }),
    requirePermission(Permission.DISPUTE_RESOLVE),
    validateBody(ResolveDisputeRequestSchema),
    asyncHandler(controller.resolve),
  );

  return router;
}
