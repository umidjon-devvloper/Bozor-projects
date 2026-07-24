/**
 * Notification taxonomy (NOTIFICATION_SYSTEM.md).
 *
 * The transactional/marketing split is the important one. A seller must be told an order
 * arrived whether or not they have opted out of anything — that message is part of the
 * service they signed up for. A promotion is not, and respects both the opt-out and quiet
 * hours.
 */
export const NotificationCategory = {
  ORDER: 'ORDER',
  WALLET: 'WALLET',
  MODERATION: 'MODERATION',
  ACCOUNT: 'ACCOUNT',
  MARKETING: 'MARKETING',
} as const;
export type NotificationCategory =
  (typeof NotificationCategory)[keyof typeof NotificationCategory];

/** Categories a user may not switch off, because they are the service itself. */
export const TRANSACTIONAL_CATEGORIES: readonly NotificationCategory[] = [
  NotificationCategory.ORDER,
  NotificationCategory.WALLET,
  NotificationCategory.MODERATION,
  NotificationCategory.ACCOUNT,
];

export const Channel = {
  PUSH: 'PUSH',
  SMS: 'SMS',
  IN_APP: 'IN_APP',
} as const;
export type Channel = (typeof Channel)[keyof typeof Channel];

export const DeliveryStatus = {
  PENDING: 'PENDING',
  SENT: 'SENT',
  DELIVERED: 'DELIVERED',
  FAILED: 'FAILED',
  SUPPRESSED: 'SUPPRESSED',
} as const;
export type DeliveryStatus = (typeof DeliveryStatus)[keyof typeof DeliveryStatus];

export const SuppressionReason = {
  OPTED_OUT: 'OPTED_OUT',
  QUIET_HOURS: 'QUIET_HOURS',
  NO_DEVICE: 'NO_DEVICE',
  NO_PHONE: 'NO_PHONE',
  DUPLICATE: 'DUPLICATE',
} as const;
export type SuppressionReason = (typeof SuppressionReason)[keyof typeof SuppressionReason];

/** Local time, in the recipient's own timezone. Marketing only. */
export const QUIET_HOURS_START = 22;
export const QUIET_HOURS_END = 8;

export const MAX_PUSH_TOKENS_PER_SEND = 500;
export const MAX_TITLE_LENGTH = 120;
export const MAX_BODY_LENGTH = 400;
export const NOTIFICATION_RETENTION_DAYS = 90;

/** Provider failures worth retrying, as opposed to a token that will never work again. */
export const RETRYABLE_PROVIDER_ERRORS = new Set([
  'UNAVAILABLE',
  'INTERNAL',
  'QUOTA_EXCEEDED',
  'TIMEOUT',
  'TooManyProviderTokenUpdates',
  'ServiceUnavailable',
]);

/** Responses that mean the token is dead and must be retired, not retried. */
export const DEAD_TOKEN_ERRORS = new Set([
  'UNREGISTERED',
  'INVALID_ARGUMENT',
  'BadDeviceToken',
  'Unregistered',
  'DeviceTokenNotForTopic',
  'DeviceNotRegistered',
]);
