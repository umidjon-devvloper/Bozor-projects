import { Router, type RequestHandler } from 'express';
import {
  CancelOrderRequestSchema,
  CreateOrderRequestSchema,
  ProposeAdjustmentRequestSchema,
  RejectOrderRequestSchema,
  RespondToAdjustmentRequestSchema,
  VerifyPickupRequestSchema,
} from '@bozorlar/contracts';
import { validateBody } from '../../../middleware/validate.js';
import { byUser, rateLimit } from '../../../middleware/rateLimit.js';
import { requirePermission } from '../../../middleware/permission.js';
import { asyncHandler } from '../../../shared/asyncHandler.js';
import { Permission } from '../../authz/index.js';
import type { OrderController } from './order.controller.js';

export function createOrderRouter(
  controller: OrderController,
  middleware: { authenticate: RequestHandler; idempotency: RequestHandler },
): Router {
  const router = Router();
  router.use(middleware.authenticate);
  const limited = rateLimit({ name: 'orders', limit: 120, windowSeconds: 60, keyResolver: byUser });

  router.post(
    '/',
    rateLimit({ name: 'orders:create', limit: 10, windowSeconds: 60, keyResolver: byUser }),
    requirePermission(Permission.ORDER_CREATE),
    validateBody(CreateOrderRequestSchema),
    // A retry on a bazaar's mobile network must not become a second order (API.md 1.11).
    middleware.idempotency,
    asyncHandler(controller.create),
  );

  router.get('/', limited, requirePermission(Permission.ORDER_READ_OWN), asyncHandler(controller.list));
  router.get('/:id', limited, requirePermission(Permission.ORDER_READ_OWN), asyncHandler(controller.get));
  router.get(
    '/:id/pickup-code',
    rateLimit({ name: 'orders:pickup-code', limit: 30, windowSeconds: 300, keyResolver: byUser }),
    requirePermission(Permission.ORDER_READ_OWN),
    asyncHandler(controller.pickupCode),
  );
  router.post(
    '/:id/cancel',
    limited,
    requirePermission(Permission.ORDER_CANCEL_OWN),
    validateBody(CancelOrderRequestSchema),
    asyncHandler(controller.cancel),
  );
  router.post(
    '/:id/confirm',
    limited,
    requirePermission(Permission.ORDER_CONFIRM_OWN),
    asyncHandler(controller.confirm),
  );
  router.post(
    '/:id/adjustment',
    limited,
    requirePermission(Permission.ORDER_CONFIRM_OWN),
    validateBody(RespondToAdjustmentRequestSchema),
    asyncHandler(controller.respondToAdjustment),
  );

  return router;
}

export function createOrderGroupRouter(
  controller: OrderController,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  router.use(authenticate);
  router.get(
    '/:id',
    rateLimit({ name: 'order-groups', limit: 120, windowSeconds: 60, keyResolver: byUser }),
    requirePermission(Permission.ORDER_READ_OWN),
    asyncHandler(controller.getGroup),
  );
  return router;
}

export function createSellerOrderRouter(
  controller: OrderController,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  router.use(authenticate);
  // Generous: a busy stall works its queue continuously through the morning.
  const limited = rateLimit({ name: 'seller:orders', limit: 300, windowSeconds: 60, keyResolver: byUser });

  router.get('/', limited, requirePermission(Permission.ORDER_READ_OWN_SHOP), asyncHandler(controller.sellerList));
  router.get('/:id', limited, requirePermission(Permission.ORDER_READ_OWN_SHOP), asyncHandler(controller.sellerGet));
  router.post('/:id/accept', limited, requirePermission(Permission.ORDER_ACCEPT_OWN_SHOP), asyncHandler(controller.accept));
  router.post(
    '/:id/reject',
    limited,
    requirePermission(Permission.ORDER_ACCEPT_OWN_SHOP),
    validateBody(RejectOrderRequestSchema),
    asyncHandler(controller.reject),
  );
  router.post('/:id/preparing', limited, requirePermission(Permission.ORDER_FULFIL_OWN_SHOP), asyncHandler(controller.preparing));
  router.post('/:id/ready', limited, requirePermission(Permission.ORDER_FULFIL_OWN_SHOP), asyncHandler(controller.ready));
  router.post(
    '/:id/adjustment',
    limited,
    requirePermission(Permission.ORDER_ADJUST_OWN_SHOP),
    validateBody(ProposeAdjustmentRequestSchema),
    asyncHandler(controller.adjust),
  );
  router.post(
    '/:id/verify-pickup',
    // Tighter than the rest: this endpoint guesses a six-digit secret, and the per-order
    // attempt counter is the second line of defence rather than the only one.
    rateLimit({ name: 'seller:verify-pickup', limit: 30, windowSeconds: 300, keyResolver: byUser }),
    requirePermission(Permission.ORDER_FULFIL_OWN_SHOP),
    validateBody(VerifyPickupRequestSchema),
    asyncHandler(controller.verifyPickup),
  );
  router.post(
    '/:id/cancel',
    limited,
    requirePermission(Permission.ORDER_FULFIL_OWN_SHOP),
    validateBody(RejectOrderRequestSchema),
    asyncHandler(controller.sellerCancel),
  );

  return router;
}
