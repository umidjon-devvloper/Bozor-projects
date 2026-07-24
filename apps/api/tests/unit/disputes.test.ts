import { describe, expect, it } from 'vitest';
import {
  DISPUTE_TRANSITIONS,
  DisputeOutcome,
  DisputeStatus,
  OrderStatus,
  ORDER_TRANSITIONS,
  TERMINAL_DISPUTE_STATUSES,
  canTransitionDispute,
  commissionReversalFor,
  refundAmountFor,
  reliabilityAfter,
  RELIABILITY_GAIN,
  RELIABILITY_LOSS,
  RELIABILITY_MAX,
} from '@bozorlar/domain';
import { DisputeStatusSchema, DisputeOutcomeSchema } from '@bozorlar/contracts';

describe('dispute transitions', () => {
  it('declares transitions for every status', () => {
    for (const status of Object.values(DisputeStatus)) {
      expect(DISPUTE_TRANSITIONS[status], status).toBeDefined();
    }
  });

  it('lets only a moderator close a case once it is under review', () => {
    // Allowing the parties to settle privately would leave the platform unable to say what
    // was decided or why.
    expect(DISPUTE_TRANSITIONS.UNDER_REVIEW).toEqual([
      DisputeStatus.RESOLVED_BUYER,
      DisputeStatus.RESOLVED_SELLER,
    ]);
    expect(canTransitionDispute(DisputeStatus.UNDER_REVIEW, DisputeStatus.WITHDRAWN)).toBe(false);
  });

  it('allows withdrawal only before arbitration', () => {
    expect(canTransitionDispute(DisputeStatus.OPEN, DisputeStatus.WITHDRAWN)).toBe(true);
  });

  it('makes every resolution final', () => {
    for (const status of TERMINAL_DISPUTE_STATUSES) {
      expect(DISPUTE_TRANSITIONS[status], status).toHaveLength(0);
    }
  });

  it('closes the hole that made DISPUTED and REFUNDED unreachable', () => {
    // These have been in the order state machine since it was written with no way in.
    expect(ORDER_TRANSITIONS.PICKED_UP).toContain(OrderStatus.DISPUTED);
    expect(ORDER_TRANSITIONS.COMPLETED).toContain(OrderStatus.DISPUTED);
    expect(ORDER_TRANSITIONS.DISPUTED).toEqual(
      expect.arrayContaining([OrderStatus.COMPLETED, OrderStatus.REFUNDED]),
    );
  });

  it('keeps the wire enums and the server enums in step', () => {
    expect([...DisputeStatusSchema.options].sort()).toEqual(Object.values(DisputeStatus).sort());
    expect([...DisputeOutcomeSchema.options].sort()).toEqual(Object.values(DisputeOutcome).sort());
  });
});

describe('refund amounts', () => {
  const total = 4_500_00n;

  it('awards the whole order on a full refund', () => {
    expect(refundAmountFor(DisputeOutcome.REFUND_FULL, total, null)).toBe(total);
  });

  it('awards nothing on a dismissal, whatever was requested', () => {
    expect(refundAmountFor(DisputeOutcome.NO_REFUND, total, 100_00n)).toBe(0n);
  });

  it('refuses a partial refund with no amount, or one of zero', () => {
    expect(() => refundAmountFor(DisputeOutcome.REFUND_PARTIAL, total, null)).toThrow();
    expect(() => refundAmountFor(DisputeOutcome.REFUND_PARTIAL, total, 0n)).toThrow();
  });

  it('refuses to award more than the buyer paid', () => {
    expect(() => refundAmountFor(DisputeOutcome.REFUND_PARTIAL, total, total + 1n)).toThrow(
      /exceed the order total/,
    );
  });

  it('awards exactly what was decided', () => {
    expect(refundAmountFor(DisputeOutcome.REFUND_PARTIAL, total, 1_200_00n)).toBe(1_200_00n);
  });
});

describe('commission reversal', () => {
  const total = 4_500_00n;
  // 3% of 45 000.00 UZS.
  const charged = 135_00n;

  it('gives back everything on a full refund', () => {
    expect(commissionReversalFor(charged, total, total)).toBe(charged);
  });

  it('gives back a proportional share on a partial refund', () => {
    // A third of the order refunded means a third of the commission returned; anything else
    // leaves the platform profiting from a transaction it just judged to have failed.
    expect(commissionReversalFor(charged, total / 3n, total)).toBe(charged / 3n);
  });

  it('gives back nothing when the seller wins', () => {
    expect(commissionReversalFor(charged, 0n, total)).toBe(0n);
  });

  it('never returns more than was charged', () => {
    expect(commissionReversalFor(charged, total * 2n, total)).toBe(charged);
  });

  it('rounds down, so a reversal cannot exceed the charge through arithmetic', () => {
    const odd = commissionReversalFor(100n, 1n, 3n);
    expect(odd).toBe(33n);
    expect(odd).toBeLessThan(100n);
  });

  it('handles an order that was never charged commission', () => {
    // Every order completed before a commission rule existed is in exactly this state.
    expect(commissionReversalFor(0n, total, total)).toBe(0n);
  });
});

describe('seller reliability', () => {
  it('costs more to lose a dispute than is regained by winning one', () => {
    // A seller regularly disputed and occasionally vindicated is still one buyers should be
    // warned about.
    expect(RELIABILITY_LOSS).toBeGreaterThan(RELIABILITY_GAIN);
  });

  it('moves in the right direction', () => {
    expect(reliabilityAfter(1000, true)).toBe(1000 - RELIABILITY_LOSS);
    expect(reliabilityAfter(900, false)).toBe(900 + RELIABILITY_GAIN);
  });

  it('is bounded at both ends', () => {
    expect(reliabilityAfter(RELIABILITY_MAX, false)).toBe(RELIABILITY_MAX);
    expect(reliabilityAfter(10, true)).toBe(0);
  });

  it('takes many clean orders to recover from one lost dispute', () => {
    let score = reliabilityAfter(1000, true);
    let wins = 0;
    while (score < 1000) {
      score = reliabilityAfter(score, false);
      wins += 1;
    }
    expect(wins).toBeGreaterThanOrEqual(7);
  });
});
