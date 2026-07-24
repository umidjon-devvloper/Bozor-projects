/**
 * Dispute policy (DISPUTE_SYSTEM.md).
 */
export const DisputeReason = {
  NOT_RECEIVED: 'NOT_RECEIVED',
  WRONG_ITEM: 'WRONG_ITEM',
  SHORT_WEIGHT: 'SHORT_WEIGHT',
  POOR_QUALITY: 'POOR_QUALITY',
  SPOILED: 'SPOILED',
  OVERCHARGED: 'OVERCHARGED',
  OTHER: 'OTHER',
} as const;
export type DisputeReason = (typeof DisputeReason)[keyof typeof DisputeReason];

/**
 * How long the seller has to answer before the case goes to a moderator anyway.
 *
 * A seller who ignores a dispute must not be able to stall it indefinitely, and a buyer
 * should not have to chase them.
 */
export const SELLER_RESPONSE_HOURS = 48;

/**
 * How the money actually moves.
 *
 * Every v1 order is cash on pickup, which means the platform never held the buyer's money and
 * therefore cannot hand it back. What it can do is reverse its own commission and record that
 * the seller owes the buyer directly. `PAYMENT_GATEWAY` exists for prepaid orders and is
 * refused until the payments module lands, rather than pretending a refund happened.
 */
export const SettlementMethod = {
  SELLER_DIRECT: 'SELLER_DIRECT',
  PAYMENT_GATEWAY: 'PAYMENT_GATEWAY',
} as const;
export type SettlementMethod = (typeof SettlementMethod)[keyof typeof SettlementMethod];

export const MAX_EVIDENCE_PHOTOS = 8;
export const MAX_MESSAGE_LENGTH = 2000;
/** Disputes are the evidentiary record behind a refund; kept far longer than orders. */
export const DISPUTE_RETENTION_DAYS = 1825;
