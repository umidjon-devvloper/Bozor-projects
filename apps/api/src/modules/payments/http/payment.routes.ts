import { Router } from 'express';
import { asyncHandler } from '../../../shared/asyncHandler.js';
import { rateLimit } from '../../../middleware/rateLimit.js';
import type { ClickController, PaymeController } from './payment.controller.js';

/**
 * Provider callback endpoints.
 *
 * No `authenticate` middleware here, deliberately. The caller is a payment provider's server
 * and has no session; the shared secret checked inside each controller is what stands in for
 * authentication, and it is checked before any part of the request is trusted.
 *
 * The rate limit is by IP and generous. Both providers retry every call by design — Payme says
 * so in its documentation — so a limit tight enough to be a defence would also drop legitimate
 * retries of real payments, which is the one failure mode worse than an unthrottled endpoint.
 */
export function createPaymentCallbackRouter(
  payme: PaymeController,
  click: ClickController,
): Router {
  const router = Router();
  const limit = rateLimit({ name: 'payments:callback', limit: 600, windowSeconds: 60 });

  router.post('/payme', limit, asyncHandler(payme.handle));
  router.post('/click/prepare', limit, asyncHandler(click.prepare));
  router.post('/click/complete', limit, asyncHandler(click.complete));

  return router;
}
