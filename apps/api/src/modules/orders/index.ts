/**
 * Public surface of the orders module (ADR-0011 rule 1).
 *
 * The worker drives `expire` and `autoComplete` from timers; the wallet module (Phase 6)
 * consumes `order.completed` from the outbox rather than calling in.
 */
export {
  createOrderService,
  type OrderService,
  type Actor,
  type LiveProductLookup,
  type BuyerLookup,
  type ShopSnapshotLookup,
} from './services/order.service.js';
export { createOrderController, type OrderController } from './http/order.controller.js';
export {
  createOrderRouter,
  createOrderGroupRouter,
  createSellerOrderRouter,
} from './http/order.routes.js';
export { orderRepository, type OrderRecord } from './repositories/order.repository.js';
export { orderCommissionWriter } from './services/orderCommission.service.js';
export { orderReviewLookup } from './services/orderReview.service.js';
export { orderDisputeWriter } from './services/orderDispute.service.js';
export { adjustmentRepository } from './repositories/adjustment.repository.js';
export {
  ACCEPT_WINDOW_MINUTES,
  AUTO_COMPLETE_HOURS,
  DISPUTE_WINDOW_HOURS,
  ADJUSTMENT_RESPONSE_MINUTES,
  PICKUP_CODE_MAX_ATTEMPTS,
  AdjustmentStatus,
  CancelReasonCode,
  CommissionStatus,
} from './orders.constants.js';
export { OrderEvents } from './events.js';
