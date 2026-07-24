/**
 * Dispute lifecycle (DISPUTE_SYSTEM.md).
 *
 * A dispute is the only way an order moves after the goods have changed hands, which is why
 * cancellation is refused from `PICKED_UP` onward: a database write cannot unwind a physical
 * handover, but an arbitrated decision about who owes what can.
 */

export const DisputeStatus = {
  /** Raised by the buyer; the seller has a window to answer. */
  OPEN: 'OPEN',
  /** The seller has answered, or their window has closed. Awaiting a moderator. */
  UNDER_REVIEW: 'UNDER_REVIEW',
  RESOLVED_BUYER: 'RESOLVED_BUYER',
  RESOLVED_SELLER: 'RESOLVED_SELLER',
  WITHDRAWN: 'WITHDRAWN',
} as const;
export type DisputeStatus = (typeof DisputeStatus)[keyof typeof DisputeStatus];

export const DISPUTE_TRANSITIONS: Readonly<Record<DisputeStatus, readonly DisputeStatus[]>> = {
  OPEN: [DisputeStatus.UNDER_REVIEW, DisputeStatus.WITHDRAWN],
  // A moderator decides; the parties do not settle it between themselves once it is here.
  UNDER_REVIEW: [DisputeStatus.RESOLVED_BUYER, DisputeStatus.RESOLVED_SELLER],
  RESOLVED_BUYER: [],
  RESOLVED_SELLER: [],
  WITHDRAWN: [],
};

export const TERMINAL_DISPUTE_STATUSES: readonly DisputeStatus[] = [
  DisputeStatus.RESOLVED_BUYER,
  DisputeStatus.RESOLVED_SELLER,
  DisputeStatus.WITHDRAWN,
];

export function canTransitionDispute(from: DisputeStatus, to: DisputeStatus): boolean {
  return DISPUTE_TRANSITIONS[from].includes(to);
}

export const DisputeOutcome = {
  /** The buyer is owed the whole order total back. */
  REFUND_FULL: 'REFUND_FULL',
  /** The buyer is owed part of it — short weight, one bad item out of several. */
  REFUND_PARTIAL: 'REFUND_PARTIAL',
  /** The seller was right; nothing is owed. */
  NO_REFUND: 'NO_REFUND',
} as const;
export type DisputeOutcome = (typeof DisputeOutcome)[keyof typeof DisputeOutcome];

/**
 * How much of the order the buyer is owed, in minor units.
 *
 * Bounded by the order total in both directions: a resolution cannot award more than was
 * paid, and a partial award of zero is a dismissal wearing the wrong label.
 */
export function refundAmountFor(
  outcome: DisputeOutcome,
  orderTotalMinor: bigint,
  requestedMinor: bigint | null,
): bigint {
  switch (outcome) {
    case DisputeOutcome.REFUND_FULL:
      return orderTotalMinor;
    case DisputeOutcome.REFUND_PARTIAL: {
      if (requestedMinor === null || requestedMinor <= 0n) {
        throw new Error('A partial refund needs an amount above zero');
      }
      if (requestedMinor > orderTotalMinor) {
        throw new Error('A refund cannot exceed the order total');
      }
      return requestedMinor;
    }
    default:
      return 0n;
  }
}

/**
 * The share of commission the platform gives back.
 *
 * Commission was charged on the order total, so a buyer recovering 40% of that total means
 * the seller kept 40% less revenue and should be charged 40% less for it. Anything else
 * leaves the platform profiting from a transaction it just judged to have failed.
 *
 * Rounded down, so the reversal can never exceed what was charged.
 */
export function commissionReversalFor(
  chargedMinor: bigint,
  refundMinor: bigint,
  orderTotalMinor: bigint,
): bigint {
  if (chargedMinor <= 0n || refundMinor <= 0n || orderTotalMinor <= 0n) return 0n;
  if (refundMinor >= orderTotalMinor) return chargedMinor;
  return (chargedMinor * refundMinor) / orderTotalMinor;
}

/**
 * Seller reliability after a decision (SELLER_SYSTEM.md).
 *
 * Scored out of 1000. A dispute lost costs materially more than one won returns, because a
 * seller who is regularly disputed and occasionally vindicated is still a seller buyers
 * should be warned about. Recovery is deliberately slow.
 */
export const RELIABILITY_MAX = 1000;
export const RELIABILITY_LOSS = 75;
export const RELIABILITY_GAIN = 10;

export function reliabilityAfter(current: number, resolvedAgainstSeller: boolean): number {
  const next = resolvedAgainstSeller ? current - RELIABILITY_LOSS : current + RELIABILITY_GAIN;
  return Math.max(0, Math.min(RELIABILITY_MAX, next));
}
