/**
 * Order timings (ORDER_SYSTEM.md "Timers").
 *
 * These move to the `settings` collection when the platform settings module lands; until
 * then they are the documented registry defaults, declared once.
 */
export const ACCEPT_WINDOW_MINUTES = 30;
export const AUTO_COMPLETE_HOURS = 48;
export const DISPUTE_WINDOW_HOURS = 72;
export const ADJUSTMENT_RESPONSE_MINUTES = 30;
export const PICKUP_CODE_MAX_ATTEMPTS = 5;
export const MAX_ORDER_LINES = 50;
export const MAX_STATUS_HISTORY = 50;

export const CancelReasonCode = {
  CHANGED_MIND: 'CHANGED_MIND',
  FOUND_ELSEWHERE: 'FOUND_ELSEWHERE',
  TOO_SLOW: 'TOO_SLOW',
  OUT_OF_STOCK: 'OUT_OF_STOCK',
  CANNOT_FULFIL: 'CANNOT_FULFIL',
  BUYER_NO_SHOW: 'BUYER_NO_SHOW',
  ADJUSTMENT_REJECTED: 'ADJUSTMENT_REJECTED',
  ADJUSTMENT_TIMEOUT: 'ADJUSTMENT_TIMEOUT',
  ACCEPT_WINDOW_EXPIRED: 'ACCEPT_WINDOW_EXPIRED',
  OTHER: 'OTHER',
} as const;
export type CancelReasonCode = (typeof CancelReasonCode)[keyof typeof CancelReasonCode];

export const AdjustmentStatus = {
  NONE: 'NONE',
  AUTO_APPROVED: 'AUTO_APPROVED',
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
} as const;
export type AdjustmentStatus = (typeof AdjustmentStatus)[keyof typeof AdjustmentStatus];

export const CommissionStatus = {
  PENDING: 'PENDING',
  CHARGED: 'CHARGED',
  REVERSED: 'REVERSED',
  FAILED: 'FAILED',
} as const;
export type CommissionStatus = (typeof CommissionStatus)[keyof typeof CommissionStatus];
