import { Router, type RequestHandler } from 'express';
import {
  ReportPeriodQuerySchema,
  SellerReportQuerySchema,
} from '@bozorlar/contracts';
import { validateQuery } from '../../../middleware/validate.js';
import { byUser, rateLimit } from '../../../middleware/rateLimit.js';
import { requirePermission } from '../../../middleware/permission.js';
import { asyncHandler } from '../../../shared/asyncHandler.js';
import { Permission } from '../../authz/index.js';
import type { ReportingController } from './reporting.controller.js';

/**
 * Reports are expensive relative to everything else the API serves — each one scans a window
 * rather than reading a rollup — so the rate limit here is tighter than elsewhere and is per
 * user rather than per IP. An admin panel that polls a dashboard should cache, not retry.
 */
const reportLimit = rateLimit({
  name: 'reporting:read',
  limit: 60,
  windowSeconds: 60,
  keyResolver: byUser,
});

export function createAdminReportingRouter(
  controller: ReportingController,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  router.use(authenticate);

  router.get(
    '/overview',
    reportLimit,
    requirePermission(Permission.REPORT_READ_PLATFORM),
    validateQuery(ReportPeriodQuerySchema),
    asyncHandler(controller.overview),
  );
  router.get(
    '/sellers',
    reportLimit,
    requirePermission(Permission.REPORT_READ_PLATFORM),
    validateQuery(SellerReportQuerySchema),
    asyncHandler(controller.sellers),
  );
  router.get(
    '/moderation',
    reportLimit,
    requirePermission(Permission.REPORT_READ_PLATFORM),
    asyncHandler(controller.moderation),
  );

  return router;
}

export function createSellerReportingRouter(
  controller: ReportingController,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  router.use(authenticate);

  router.get(
    '/statement',
    reportLimit,
    requirePermission(Permission.REPORT_READ_OWN_SHOP),
    validateQuery(ReportPeriodQuerySchema),
    asyncHandler(controller.ownStatement),
  );

  return router;
}
