/** Dispute domain events (EVENTS.md). */
export const DisputeEvents = {
  RAISED: 'dispute.raised',
  SELLER_RESPONDED: 'dispute.seller_responded',
  ESCALATED: 'dispute.escalated',
  RESOLVED: 'dispute.resolved',
  WITHDRAWN: 'dispute.withdrawn',
  /** Consumed by the wallet module to reverse commission. */
  REFUND_ORDERED: 'dispute.refund_ordered',
} as const;

export type DisputeEvent = (typeof DisputeEvents)[keyof typeof DisputeEvents];
