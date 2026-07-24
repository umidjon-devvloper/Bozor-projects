import { Router, type RequestHandler } from 'express';
import { TestNotificationRequestSchema, UpdatePreferencesRequestSchema } from '@bozorlar/contracts';
import { validateBody } from '../../../middleware/validate.js';
import { byUser, rateLimit } from '../../../middleware/rateLimit.js';
import { requirePermission } from '../../../middleware/permission.js';
import { asyncHandler } from '../../../shared/asyncHandler.js';
import { Permission } from '../../authz/index.js';
import type { NotificationController } from './notification.controller.js';

export function createNotificationRouter(
  controller: NotificationController,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  router.use(authenticate);
  // Polled by the app for the unread badge, so the ceiling is generous.
  const limited = rateLimit({ name: 'notifications', limit: 300, windowSeconds: 60, keyResolver: byUser });

  router.get('/', limited, requirePermission(Permission.NOTIFICATION_READ_OWN), asyncHandler(controller.list));
  router.get('/unread-count', limited, requirePermission(Permission.NOTIFICATION_READ_OWN), asyncHandler(controller.unreadCount));
  router.post('/:id/read', limited, requirePermission(Permission.NOTIFICATION_READ_OWN), asyncHandler(controller.markRead));
  router.post('/read-all', limited, requirePermission(Permission.NOTIFICATION_READ_OWN), asyncHandler(controller.markAllRead));

  router.get('/preferences', limited, requirePermission(Permission.NOTIFICATION_READ_OWN), asyncHandler(controller.getPreferences));
  router.put(
    '/preferences',
    rateLimit({ name: 'notifications:prefs', limit: 30, windowSeconds: 3600, keyResolver: byUser }),
    requirePermission(Permission.NOTIFICATION_READ_OWN),
    validateBody(UpdatePreferencesRequestSchema),
    asyncHandler(controller.updatePreferences),
  );

  return router;
}

export function createNotificationAdminRouter(
  controller: NotificationController,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  router.use(authenticate);
  router.post(
    '/notifications/test',
    // Sends a real push to a real device; tight enough that it cannot be used as a megaphone.
    rateLimit({ name: 'admin:notification-test', limit: 20, windowSeconds: 3600, keyResolver: byUser }),
    requirePermission(Permission.NOTIFICATION_TEST_SEND),
    validateBody(TestNotificationRequestSchema),
    asyncHandler(controller.testSend),
  );
  return router;
}
