/**
 * Order domain events (EVENTS.md).
 *
 * RECONSTRUCTED during repository recovery. All eleven constant names are proved by call
 * sites in `order.service.ts`; eight of the wire strings are proved by subscribers (the
 * notification templates and the worker's order handlers). Three — PREPARING, PICKED_UP and
 * ADJUSTMENT_APPROVED — have no subscriber today and follow the same convention.
 */
export const OrderEvents = {
  CREATED: 'order.created',
  ACCEPTED: 'order.accepted',
  REJECTED: 'order.rejected',
  PREPARING: 'order.preparing',
  READY_FOR_PICKUP: 'order.ready_for_pickup',
  PICKED_UP: 'order.picked_up',
  COMPLETED: 'order.completed',
  CANCELLED: 'order.cancelled',
  EXPIRED: 'order.expired',
  ADJUSTMENT_REQUESTED: 'order.adjustment_requested',
  ADJUSTMENT_APPROVED: 'order.adjustment_approved',
} as const;

export type OrderEvent = (typeof OrderEvents)[keyof typeof OrderEvents];
