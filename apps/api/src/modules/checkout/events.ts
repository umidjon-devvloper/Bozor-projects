/** Checkout domain events (EVENTS.md). */
export const CheckoutEvents = {
  CART_ITEM_ADDED: 'cart.item_added',
  QUOTE_CREATED: 'checkout.quoted',
  STOCK_RESERVED: 'stock.reserved',
  STOCK_RELEASED: 'stock.released',
  RESERVATION_EXPIRED: 'stock.reservation_expired',
} as const;

export type CheckoutEvent = (typeof CheckoutEvents)[keyof typeof CheckoutEvents];
