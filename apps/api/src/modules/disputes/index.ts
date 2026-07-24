/**
 * Public surface of the disputes module (ADR-0011 rule 1).
 *
 * Nothing outside calls in; the worker drives the seller-response timeout through the service,
 * and the wallet module hears about refunds through the outbox.
 */
export {
  createDisputeService,
  type DisputeService,
  type OrderDisputePort,
  type CommissionReverser,
} from './services/dispute.service.js';
export { createDisputeController, type DisputeController } from './http/dispute.controller.js';
export {
  createDisputeRouter,
  createSellerDisputeRouter,
  createDisputeAdminRouter,
} from './http/dispute.routes.js';
export { DisputeReason, SettlementMethod, SELLER_RESPONSE_HOURS } from './disputes.constants.js';
export { DisputeEvents } from './events.js';
