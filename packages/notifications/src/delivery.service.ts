import { AppError, ErrorCode } from '@bozorlar/errors';
import { DEFAULT_LOCALE, type Locale } from '@bozorlar/types';
import {
  Channel,
  DEAD_TOKEN_ERRORS,
  DeliveryStatus,
  MAX_PUSH_TOKENS_PER_SEND,
  NotificationCategory,
  QUIET_HOURS_END,
  QUIET_HOURS_START,
  RETRYABLE_PROVIDER_ERRORS,
  SuppressionReason,
  TRANSACTIONAL_CATEGORIES,
} from './constants.js';
import { isWithinQuietHours, renderTemplate } from './render.js';
import { TEMPLATES_BY_TYPE } from './templates.js';
import { notificationRepository, preferenceRepository } from './repositories/notification.repository.js';
import { recipientRepository } from './repositories/recipient.repository.js';
import type { DeliveryAttempt } from './models/notification.model.js';
import type { PushProvider, PushMessage } from './providers/types.js';

export interface NotificationLogger {
  debug(context: Record<string, unknown>, message: string): void;
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

/** SMS is owned by the identity module; the engine takes it as a port. */
export interface SmsSender {
  send(to: string, message: string): Promise<void>;
}

export interface SendRequest {
  /** The event id, so a redelivered event notifies once. */
  dedupeKey: string;
  userId: string;
  type: string;
  variables: Record<string, string>;
  targetId?: string | undefined;
  /** Overrides the template's channels — used by the admin test-send. */
  channels?: readonly Channel[] | undefined;
}

export interface SendOutcome {
  sent: boolean;
  notificationId: string | null;
  attempts: DeliveryAttempt[];
}

export function createDeliveryService(deps: {
  providers: readonly PushProvider[];
  sms: SmsSender | null;
  logger: NotificationLogger;
  appBaseUrl: string;
}) {
  const { providers, sms, logger, appBaseUrl } = deps;

  /**
   * Chooses a provider for a token.
   *
   * Expo tokens are recognisable by their prefix and must go through Expo regardless of the
   * device's platform — they are not FCM or APNs tokens, and sending them to either produces
   * a confusing "invalid token" that looks like a dead device.
   */
  function providerFor(token: string, platform: string): PushProvider | null {
    if (token.startsWith('ExponentPushToken[') || token.startsWith('ExpoPushToken[')) {
      return providers.find((provider) => provider.name === 'expo') ?? null;
    }
    if (platform === 'IOS') return providers.find((provider) => provider.name === 'apns') ?? null;
    return providers.find((provider) => provider.name === 'fcm') ?? null;
  }

  function isEnabled(
    preferences: Awaited<ReturnType<typeof preferenceRepository.findForUser>>,
    category: NotificationCategory,
    channel: Channel,
  ): boolean {
    // Transactional messages are the service itself, not something to opt out of.
    if (TRANSACTIONAL_CATEGORIES.includes(category)) return true;
    const preference = preferences?.channels.find(
      (candidate) => candidate.category === category && candidate.channel === channel,
    );
    return preference?.enabled ?? true;
  }

  return {
    /**
     * Renders, records and delivers one notification.
     *
     * The record is written *before* any provider is called, so a crash mid-send leaves
     * evidence that the attempt happened rather than a silent gap — and the unique dedupe key
     * means the retry after that crash will not send a second copy.
     */
    async send(request: SendRequest): Promise<SendOutcome> {
      const template = TEMPLATES_BY_TYPE.get(request.type);
      if (!template) {
        throw new AppError(ErrorCode.NOTIFICATION_TEMPLATE_INVALID, {
          detail: `No notification template for "${request.type}"`,
        });
      }

      const recipient = await recipientRepository.find(request.userId);
      if (!recipient || recipient.status !== 'ACTIVE') {
        logger.debug({ userId: request.userId, type: request.type }, 'recipient unavailable');
        return { sent: false, notificationId: null, attempts: [] };
      }

      const preferences = await preferenceRepository.findForUser(request.userId);
      const locale = (recipient.locale as Locale) || DEFAULT_LOCALE;
      const rendered = renderTemplate(template, locale, request.variables);

      const target =
        template.targetType && request.targetId
          ? { type: template.targetType, id: request.targetId }
          : null;

      const notification = await notificationRepository.claim({
        dedupeKey: request.dedupeKey,
        userId: request.userId,
        category: template.category,
        type: template.type,
        title: rendered.title,
        body: rendered.body,
        locale,
        target,
        data: { type: template.type, ...(target ? { targetType: target.type, targetId: target.id } : {}) },
      });

      if (!notification) {
        // Lost the race with a redelivery of the same event. Nothing further to do.
        logger.debug({ dedupeKey: request.dedupeKey }, 'notification already delivered');
        return { sent: false, notificationId: null, attempts: [] };
      }

      const channels = request.channels ?? template.channels;
      const attempts: DeliveryAttempt[] = [];
      const now = new Date();

      // IN_APP is the notification record itself; claiming it is delivering it.
      if (channels.includes(Channel.IN_APP)) {
        attempts.push({
          channel: Channel.IN_APP,
          status: DeliveryStatus.DELIVERED,
          provider: null,
          providerMessageId: null,
          error: null,
          suppressionReason: null,
          attemptedAt: now,
        });
      }

      if (channels.includes(Channel.PUSH)) {
        attempts.push(...(await this.deliverPush(recipient, rendered, template, preferences, target, now)));
      }

      if (channels.includes(Channel.SMS)) {
        attempts.push(await this.deliverSms(recipient, rendered, template, preferences, now));
      }

      await notificationRepository.recordAttempts(notification.id, attempts);

      const sent = attempts.some((attempt) => attempt.status === DeliveryStatus.SENT || attempt.status === DeliveryStatus.DELIVERED);
      logger.info(
        { notificationId: notification.id, type: request.type, userId: request.userId, sent },
        'notification processed',
      );
      return { sent, notificationId: notification.id, attempts };
    },

    async deliverPush(
      recipient: Awaited<ReturnType<typeof recipientRepository.find>>,
      rendered: { title: string; body: string },
      template: { category: NotificationCategory; type: string },
      preferences: Awaited<ReturnType<typeof preferenceRepository.findForUser>>,
      target: { type: string; id: string } | null,
      now: Date,
    ): Promise<DeliveryAttempt[]> {
      if (!recipient) return [];
      const base = {
        channel: Channel.PUSH,
        provider: null,
        providerMessageId: null,
        error: null,
        suppressionReason: null,
        attemptedAt: now,
      };

      if (!isEnabled(preferences, template.category, Channel.PUSH)) {
        return [{ ...base, status: DeliveryStatus.SUPPRESSED, suppressionReason: SuppressionReason.OPTED_OUT }];
      }
      if (
        !TRANSACTIONAL_CATEGORIES.includes(template.category) &&
        isWithinQuietHours(now, preferences?.timezone ?? 'Asia/Tashkent', QUIET_HOURS_START, QUIET_HOURS_END)
      ) {
        return [{ ...base, status: DeliveryStatus.SUPPRESSED, suppressionReason: SuppressionReason.QUIET_HOURS }];
      }
      if (recipient.devices.length === 0) {
        return [{ ...base, status: DeliveryStatus.SUPPRESSED, suppressionReason: SuppressionReason.NO_DEVICE }];
      }

      const targetUrl = target ? `${appBaseUrl.replace(/\/$/, '')}/${target.type}/${target.id}` : null;
      const byProvider = new Map<PushProvider, PushMessage[]>();

      for (const device of recipient.devices.slice(0, MAX_PUSH_TOKENS_PER_SEND)) {
        const provider = providerFor(device.pushToken, device.platform);
        if (!provider) continue;
        const messages = byProvider.get(provider) ?? [];
        messages.push({
          token: device.pushToken,
          title: rendered.title,
          body: rendered.body,
          data: { type: template.type },
          targetUrl,
        });
        byProvider.set(provider, messages);
      }

      if (byProvider.size === 0) {
        return [{ ...base, status: DeliveryStatus.SUPPRESSED, suppressionReason: SuppressionReason.NO_DEVICE }];
      }

      const attempts: DeliveryAttempt[] = [];
      for (const [provider, messages] of byProvider) {
        let results;
        try {
          results = await provider.send(messages);
        } catch (cause) {
          attempts.push({
            ...base,
            status: DeliveryStatus.FAILED,
            provider: provider.name,
            error: cause instanceof Error ? cause.message : 'provider threw',
          });
          continue;
        }

        for (const result of results) {
          if (result.ok) {
            attempts.push({
              ...base,
              status: DeliveryStatus.SENT,
              provider: provider.name,
              providerMessageId: result.messageId,
            });
            continue;
          }

          const code = result.errorCode ?? 'UNKNOWN';
          // A dead token is retired rather than retried: sending to it again produces the
          // same answer forever and slowly turns the fan-out into noise.
          if (DEAD_TOKEN_ERRORS.has(code)) {
            const retired = await recipientRepository.invalidateToken(result.token, code);
            logger.warn({ provider: provider.name, code, retired }, 'push token retired');
          } else if (!RETRYABLE_PROVIDER_ERRORS.has(code)) {
            logger.error({ provider: provider.name, code, message: result.errorMessage }, 'push failed');
          }

          attempts.push({
            ...base,
            status: DeliveryStatus.FAILED,
            provider: provider.name,
            error: `${code}${result.errorMessage ? `: ${result.errorMessage}` : ''}`,
          });
        }
      }
      return attempts;
    },

    async deliverSms(
      recipient: Awaited<ReturnType<typeof recipientRepository.find>>,
      rendered: { title: string; body: string },
      template: { category: NotificationCategory },
      preferences: Awaited<ReturnType<typeof preferenceRepository.findForUser>>,
      now: Date,
    ): Promise<DeliveryAttempt> {
      const base = {
        channel: Channel.SMS,
        provider: 'sms',
        providerMessageId: null,
        error: null,
        suppressionReason: null,
        attemptedAt: now,
      };

      if (!recipient || !recipient.phone) {
        return { ...base, status: DeliveryStatus.SUPPRESSED, suppressionReason: SuppressionReason.NO_PHONE };
      }
      if (!isEnabled(preferences, template.category, Channel.SMS)) {
        return { ...base, status: DeliveryStatus.SUPPRESSED, suppressionReason: SuppressionReason.OPTED_OUT };
      }
      if (!sms) {
        return { ...base, status: DeliveryStatus.FAILED, error: 'no SMS sender configured' };
      }

      try {
        // SMS costs money per message, so the title is dropped and only the body is sent.
        await sms.send(recipient.phone, rendered.body);
        return { ...base, status: DeliveryStatus.SENT };
      } catch (cause) {
        return {
          ...base,
          status: DeliveryStatus.FAILED,
          error: cause instanceof Error ? cause.message : 'sms failed',
        };
      }
    },
  };
}

export type DeliveryService = ReturnType<typeof createDeliveryService>;
