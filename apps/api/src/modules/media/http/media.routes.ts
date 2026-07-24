import { Router, type RequestHandler } from 'express';
import { ConfirmUploadRequestSchema, CreateUploadUrlRequestSchema } from '@bozorlar/contracts';
import { validateBody } from '../../../middleware/validate.js';
import { byUser, rateLimit } from '../../../middleware/rateLimit.js';
import { requirePermission } from '../../../middleware/permission.js';
import { asyncHandler } from '../../../shared/asyncHandler.js';
import { Permission } from '../../authz/index.js';
import type { MediaController } from './media.controller.js';

/**
 * Media routes.
 *
 * The path parameter is `:mediaKey(*)` because keys contain slashes. Express would otherwise
 * match only the first segment and every lookup would miss.
 */
export function createMediaRouter(
  controller: MediaController,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  router.use(authenticate);

  router.post(
    '/upload-url',
    // Ticket issue is cheap but is the entry point to storage cost, so it is capped well
    // below the per-purpose daily quota that the service also enforces.
    rateLimit({ name: 'media:ticket', limit: 50, windowSeconds: 3600, keyResolver: byUser }),
    requirePermission(Permission.MEDIA_UPLOAD),
    validateBody(CreateUploadUrlRequestSchema),
    asyncHandler(controller.createUploadUrl),
  );

  router.post(
    '/confirm',
    // The only expensive endpoint in the module: it downloads, scans and re-encodes.
    rateLimit({ name: 'media:confirm', limit: 60, windowSeconds: 3600, keyResolver: byUser }),
    requirePermission(Permission.MEDIA_UPLOAD),
    validateBody(ConfirmUploadRequestSchema),
    asyncHandler(controller.confirm),
  );

  router.get(
    '/:mediaKey(*)/download-url',
    rateLimit({ name: 'media:download', limit: 120, windowSeconds: 3600, keyResolver: byUser }),
    asyncHandler(controller.downloadUrl),
  );

  router.delete(
    '/:mediaKey(*)',
    rateLimit({ name: 'media:delete', limit: 60, windowSeconds: 3600, keyResolver: byUser }),
    asyncHandler(controller.remove),
  );

  return router;
}
