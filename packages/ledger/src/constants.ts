export const EntryType = {
  COMMISSION_CHARGE: 'COMMISSION_CHARGE',
  COMMISSION_REVERSAL: 'COMMISSION_REVERSAL',
  TOP_UP: 'TOP_UP',
  MANUAL_CREDIT: 'MANUAL_CREDIT',
  MANUAL_DEBIT: 'MANUAL_DEBIT',
  OPENING_BALANCE: 'OPENING_BALANCE',
} as const;
export type EntryType = (typeof EntryType)[keyof typeof EntryType];

export const CommissionFailureReason = {
  NO_APPLICABLE_RULE: 'NO_APPLICABLE_RULE',
  WALLET_MISSING: 'WALLET_MISSING',
  ORDER_NOT_COMPLETED: 'ORDER_NOT_COMPLETED',
} as const;
export type CommissionFailureReason =
  (typeof CommissionFailureReason)[keyof typeof CommissionFailureReason];

/**
 * Rule scope, most specific first.
 *
 * A rule for one shop beats a rule for its category, which beats the platform default. Ties
 * are broken by explicit priority, then by the most recent `effectiveFrom` — so entering a
 * new rate is always additive and never requires editing the old one.
 */
export const RuleScope = {
  SHOP: 'SHOP',
  MARKET: 'MARKET',
  CATEGORY: 'CATEGORY',
  PLATFORM: 'PLATFORM',
} as const;
export type RuleScope = (typeof RuleScope)[keyof typeof RuleScope];

export const SCOPE_SPECIFICITY: Readonly<Record<RuleScope, number>> = {
  SHOP: 4,
  MARKET: 3,
  CATEGORY: 2,
  PLATFORM: 1,
};

/** Manual ledger movements above this need a second administrator (SECURITY.md). */
export const DUAL_CONTROL_THRESHOLD_MINOR = 100_000_00n;

export const MAX_MANUAL_ADJUSTMENT_MINOR = 10_000_000_00n;

/** Wallet and commission events (EVENTS.md). Emitted by whichever app moves the money. */
export const WalletEvents = {
  COMMISSION_CHARGED: 'commission.charged',
  COMMISSION_FAILED: 'commission.failed',
  COMMISSION_REVERSED: 'commission.reversed',
  WALLET_CREDITED: 'wallet.credited',
  WALLET_DEBITED: 'wallet.debited',
  WALLET_LOW: 'wallet.low_balance',
  /** The geo module's `sellerWalletActive` flag follows these two. */
  SELLER_DEACTIVATED: 'seller.deactivated',
  SELLER_REACTIVATED: 'seller.reactivated',
} as const;
export type WalletEvent = (typeof WalletEvents)[keyof typeof WalletEvents];
