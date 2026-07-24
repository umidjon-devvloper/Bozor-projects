import { Router, type RequestHandler } from 'express';
import {
  AddCartItemRequestSchema,
  CreateQuoteRequestSchema,
  MergeCartRequestSchema,
  UpdateCartItemRequestSchema,
} from '@bozorlar/contracts';
import { validateBody } from '../../../middleware/validate.js';
import { byUser, rateLimit } from '../../../middleware/rateLimit.js';
import { requirePermission } from '../../../middleware/permission.js';
import { asyncHandler } from '../../../shared/asyncHandler.js';
import { Permission } from '../../authz/index.js';
import type { CheckoutController } from './checkout.controller.js';

export function createCartRouter(
  controller: CheckoutController,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  router.use(authenticate);
  const limited = rateLimit({ name: 'cart', limit: 120, windowSeconds: 60, keyResolver: byUser });

  router.get('/', limited, requirePermission(Permission.CART_MANAGE_OWN), asyncHandler(controller.getCart));
  router.post(
    '/items',
    limited,
    requirePermission(Permission.CART_MANAGE_OWN),
    validateBody(AddCartItemRequestSchema),
    asyncHandler(controller.addItem),
  );
  router.patch(
    '/items/:lineId',
    limited,
    requirePermission(Permission.CART_MANAGE_OWN),
    validateBody(UpdateCartItemRequestSchema),
    asyncHandler(controller.updateItem),
  );
  router.delete(
    '/items/:lineId',
    limited,
    requirePermission(Permission.CART_MANAGE_OWN),
    asyncHandler(controller.removeItem),
  );
  router.delete('/', limited, requirePermission(Permission.CART_MANAGE_OWN), asyncHandler(controller.clearCart));
  router.post(
    '/merge',
    rateLimit({ name: 'cart:merge', limit: 10, windowSeconds: 3600, keyResolver: byUser }),
    requirePermission(Permission.CART_MANAGE_OWN),
    validateBody(MergeCartRequestSchema),
    asyncHandler(controller.mergeCart),
  );

  return router;
}

export function createCheckoutRouter(
  controller: CheckoutController,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  router.use(authenticate);

  router.post(
    '/quote',
    // Each quote takes real stock out of circulation for fifteen minutes, so the limit is
    // tight enough that a script cannot lock a popular product out of the market (API.md Part 7).
    rateLimit({ name: 'checkout:quote', limit: 20, windowSeconds: 60, keyResolver: byUser }),
    requirePermission(Permission.CHECKOUT_QUOTE),
    validateBody(CreateQuoteRequestSchema),
    asyncHandler(controller.createQuote),
  );
  router.get(
    '/quote/:quoteId',
    rateLimit({ name: 'checkout:quote-read', limit: 60, windowSeconds: 60, keyResolver: byUser }),
    requirePermission(Permission.CHECKOUT_QUOTE),
    asyncHandler(controller.getQuote),
  );

  return router;
}
