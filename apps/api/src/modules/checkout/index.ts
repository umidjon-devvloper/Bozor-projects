/**
 * Public surface of the checkout module (ADR-0011 rule 1).
 *
 * The orders module consumes `getQuote`, `releaseHolds` and the reservation repository's
 * `commitHold` to turn an offer into an order; nothing else should be reachable from outside.
 */
export { createCartService, type CartService, type CartView, evaluateLine } from './services/cart.service.js';
export {
  createQuoteService,
  computeContentHash,
  type QuoteService,
  type QuoteIssue,
  type ShopSummary,
  type ShopSummaryLookup,
} from './services/quote.service.js';
export { createCheckoutController, type CheckoutController } from './http/checkout.controller.js';
export { createCartRouter, createCheckoutRouter } from './http/checkout.routes.js';
export { reservationRepository } from './repositories/reservation.repository.js';
export { quoteRepository, type QuoteRecord } from './repositories/quote.repository.js';
export {
  ReservationStatus,
  LineIssue,
  RESERVATION_TTL_MINUTES,
  QUOTE_TTL_MINUTES,
  PICKUP_WINDOW_HOURS,
} from './checkout.constants.js';
export { CheckoutEvents } from './events.js';
