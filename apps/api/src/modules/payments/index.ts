/**
 * Public surface of the payments module (ADR-0011 rule 1).
 *
 * Only wallet top-ups today. Buyer-side prepaid orders reuse the same transaction row and
 * state machine, and are deliberately not built until the top-up path has run against a real
 * cashbox — see PAYMENTS.md.
 */
export { createPaymentService, type PaymentService } from './services/payment.service.js';
export {
  createPaymeController,
  createClickController,
  type PaymeController,
  type ClickController,
} from './http/payment.controller.js';
export { createPaymentCallbackRouter } from './http/payment.routes.js';
export {
  PaymentProvider,
  PaymentPurpose,
  PaymeState,
  PaymeError,
  ClickError,
  PAYME_TIMEOUT_MS,
} from './payments.constants.js';
export {
  clickSignature,
  clickAmountToMinor,
  signatureMatches,
} from './services/clickProtocol.js';
export {
  verifyPaymeAuth,
  hasTimedOut,
  cancelledState,
  PaymeRpcError,
} from './services/paymeProtocol.js';
