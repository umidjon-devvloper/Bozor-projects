import { Router, type RequestHandler } from 'express';
import {
  CreateCommissionRuleRequestSchema,
  ManualAdjustmentRequestSchema,
  PreviewCommissionRequestSchema,
  SetWalletThresholdsRequestSchema,
} from '@bozorlar/contracts';
import { validateBody } from '../../../middleware/validate.js';
import { byUser, rateLimit } from '../../../middleware/rateLimit.js';
import { requirePermission } from '../../../middleware/permission.js';
import { asyncHandler } from '../../../shared/asyncHandler.js';
import { Permission } from '../../authz/index.js';
import type { WalletController } from './wallet.controller.js';

export function createSellerWalletRouter(
  controller: WalletController,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  router.use(authenticate);
  const limited = rateLimit({ name: 'seller:wallet', limit: 120, windowSeconds: 60, keyResolver: byUser });

  router.get('/', limited, requirePermission(Permission.WALLET_READ_OWN), asyncHandler(controller.myWallet));
  router.get('/statement', limited, requirePermission(Permission.WALLET_READ_OWN), asyncHandler(controller.myStatement));
  return router;
}

export function createWalletAdminRouter(
  controller: WalletController,
  middleware: { authenticate: RequestHandler; idempotency: RequestHandler },
): Router {
  const router = Router();
  router.use(middleware.authenticate);
  const limited = rateLimit({ name: 'admin:wallet', limit: 120, windowSeconds: 60, keyResolver: byUser });

  router.get('/wallets/:sellerId', limited, requirePermission(Permission.WALLET_ADMIN), asyncHandler(controller.getWallet));
  router.get(
    '/wallets/:sellerId/reconcile',
    rateLimit({ name: 'admin:reconcile', limit: 30, windowSeconds: 300, keyResolver: byUser }),
    requirePermission(Permission.WALLET_ADMIN),
    asyncHandler(controller.reconcile),
  );
  router.patch(
    '/wallets/:sellerId/thresholds',
    limited,
    requirePermission(Permission.WALLET_ADMIN),
    validateBody(SetWalletThresholdsRequestSchema),
    asyncHandler(controller.setThresholds),
  );

  router.post(
    '/ledger/adjustments',
    // Tight, audited at CRITICAL, dual-controlled above the threshold, and idempotent: a
    // retried credit must not become two.
    rateLimit({ name: 'admin:ledger-adjust', limit: 20, windowSeconds: 3600, keyResolver: byUser }),
    requirePermission(Permission.LEDGER_CREDIT_MANUAL),
    validateBody(ManualAdjustmentRequestSchema),
    middleware.idempotency,
    asyncHandler(controller.adjust),
  );

  router.get(
    '/commission-rules',
    limited,
    requirePermission(Permission.LEDGER_READ),
    asyncHandler(controller.listRules),
  );
  router.post(
    '/commission-rules',
    rateLimit({ name: 'admin:commission-rule', limit: 10, windowSeconds: 3600, keyResolver: byUser }),
    // SUPER_ADMIN only: this is the number the business runs on.
    requirePermission(Permission.COMMISSION_RULE_MANAGE),
    validateBody(CreateCommissionRuleRequestSchema),
    asyncHandler(controller.createRule),
  );
  router.post(
    '/commission-rules/preview',
    limited,
    requirePermission(Permission.LEDGER_READ),
    validateBody(PreviewCommissionRequestSchema),
    asyncHandler(controller.previewRule),
  );

  return router;
}
