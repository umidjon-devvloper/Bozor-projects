import type { Request, Response } from 'express';
import { AppError, ErrorCode } from '@bozorlar/errors';
import {
  notificationRepository,
  preferenceRepository,
  TEMPLATES,
  TRANSACTIONAL_CATEGORIES,
  type DeliveryService,
  type NotificationRecord,
} from '@bozorlar/notifications';
import { sendData, sendNoContent } from '../../../http/envelope.js';

function requireAuth(req: Request) {
  if (!req.auth) throw new AppError(ErrorCode.AUTH_REQUIRED);
  return req.auth;
}

function requireParam(value: string | undefined, name: string): string {
  if (!value) throw new AppError(ErrorCode.RESOURCE_NOT_FOUND, { detail: `${name} not found` });
  return value;
}

function toResponse(notification: NotificationRecord) {
  return {
    id: notification.id,
    category: notification.category,
    type: notification.type,
    title: notification.title,
    body: notification.body,
    target: notification.target,
    read: notification.readAt !== null,
    createdAt: notification.createdAt.toISOString(),
  };
}

export function createNotificationController(delivery: DeliveryService) {
  const noStore = (res: Response): void => {
    res.setHeader('Cache-Control', 'private, no-store');
  };

  return {
    async list(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      const limit = Math.min(Number(req.query.limit ?? 30), 100);
      const before = typeof req.query.before === 'string' ? new Date(req.query.before) : undefined;
      const [items, unread] = await Promise.all([
        notificationRepository.listForUser(auth.userId, limit, before),
        notificationRepository.unreadCount(auth.userId),
      ]);
      noStore(res);
      sendData(res, { items: items.map(toResponse), unreadCount: unread });
    },

    async unreadCount(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      noStore(res);
      sendData(res, { unreadCount: await notificationRepository.unreadCount(auth.userId) });
    },

    async markRead(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      const marked = await notificationRepository.markRead(
        auth.userId,
        requireParam(req.params.id, 'Notification'),
      );
      // Already read is a success, not a conflict: two devices tapping the same item is normal.
      if (!marked) {
        const exists = await notificationRepository.listForUser(auth.userId, 1);
        if (exists.length === 0) throw new AppError(ErrorCode.NOTIFICATION_NOT_FOUND, { detail: 'Not found' });
      }
      sendNoContent(res);
    },

    async markAllRead(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      sendData(res, { marked: await notificationRepository.markAllRead(auth.userId) });
    },

    /**
     * Preferences, with the transactional categories reported as locked rather than absent.
     *
     * A settings screen that silently omits order notifications looks like a bug; one that
     * shows them greyed out with a reason explains itself.
     */
    async getPreferences(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      const stored = await preferenceRepository.findForUser(auth.userId);
      const categories = [...new Set(TEMPLATES.map((template) => template.category))];
      noStore(res);
      sendData(res, {
        timezone: stored?.timezone ?? 'Asia/Tashkent',
        categories: categories.map((category) => ({
          category,
          locked: TRANSACTIONAL_CATEGORIES.includes(category),
          channels: ['PUSH', 'SMS', 'IN_APP'].map((channel) => ({
            channel,
            enabled:
              TRANSACTIONAL_CATEGORIES.includes(category) ||
              (stored?.channels.find(
                (candidate) => candidate.category === category && candidate.channel === channel,
              )?.enabled ??
                true),
          })),
        })),
      });
    },

    async updatePreferences(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      const body = req.body as {
        channels: Array<{ category: never; channel: never; enabled: boolean }>;
        timezone?: string;
      };
      // Attempts to switch off a transactional category are dropped rather than rejected:
      // the client is not misbehaving, it just sent the whole form back.
      const channels = body.channels.filter(
        (entry) => !TRANSACTIONAL_CATEGORIES.includes(entry.category),
      );
      const updated = await preferenceRepository.upsert(auth.userId, {
        channels,
        ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
      });
      noStore(res);
      sendData(res, { timezone: updated.timezone, channels: updated.channels });
    },

    /** Lets an operator prove a device is reachable without waiting for a real order. */
    async testSend(req: Request, res: Response): Promise<void> {
      const body = req.body as {
        userId: string;
        type: string;
        variables: Record<string, string>;
        channels?: Array<'PUSH' | 'SMS' | 'IN_APP'>;
      };
      const outcome = await delivery.send({
        dedupeKey: `test:${body.userId}:${Date.now()}`,
        userId: body.userId,
        type: body.type,
        variables: body.variables,
        ...(body.channels !== undefined ? { channels: body.channels } : {}),
      });
      noStore(res);
      sendData(res, {
        sent: outcome.sent,
        notificationId: outcome.notificationId,
        attempts: outcome.attempts.map((attempt) => ({
          channel: attempt.channel,
          status: attempt.status,
          provider: attempt.provider,
          error: attempt.error,
          suppressionReason: attempt.suppressionReason,
        })),
      });
    },
  };
}

export type NotificationController = ReturnType<typeof createNotificationController>;
