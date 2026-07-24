/**
 * Public surface of the notifications module (ADR-0011 rule 1).
 *
 * The delivery engine lives in `@bozorlar/notifications`, shared with the worker, because
 * events are relayed there. This module is the read surface over it: the inbox, the unread
 * badge, preferences, and an operator's test send.
 */
export {
  createNotificationController,
  type NotificationController,
} from './http/notification.controller.js';
export {
  createNotificationRouter,
  createNotificationAdminRouter,
} from './http/notification.routes.js';
