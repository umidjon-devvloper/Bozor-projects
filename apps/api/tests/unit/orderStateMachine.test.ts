import { describe, expect, it } from 'vitest';
import {
  CancelActor,
  ORDER_TRANSITIONS,
  OrderStatus,
  STOCK_HELD_STATUSES,
  TERMINAL_ORDER_STATUSES,
  cancelRule,
  canTransition,
  deriveGroupStatus,
  GroupStatus,
  isWithinTolerance,
} from '@bozorlar/domain';
import { OrderStatusSchema } from '@bozorlar/contracts';

describe('order transitions', () => {
  it('declares transitions for every status', () => {
    for (const status of Object.values(OrderStatus)) {
      expect(ORDER_TRANSITIONS[status], status).toBeDefined();
    }
  });

  it('cannot reach COMPLETED without passing through PICKED_UP', () => {
    // Completion is what triggers the commission charge, so it must follow a verified
    // handover rather than any earlier state.
    const reaches = Object.entries(ORDER_TRANSITIONS)
      .filter(([, next]) => next.includes(OrderStatus.COMPLETED))
      .map(([from]) => from)
      .sort();
    expect(reaches).toEqual([OrderStatus.DISPUTED, OrderStatus.PICKED_UP].sort());
  });

  it('makes rejection, expiry and cancellation final', () => {
    for (const status of [OrderStatus.REJECTED, OrderStatus.EXPIRED, OrderStatus.CANCELLED]) {
      expect(ORDER_TRANSITIONS[status]).toHaveLength(0);
    }
  });

  it('does not allow cancellation once goods have changed hands', () => {
    expect(canTransition(OrderStatus.PICKED_UP, OrderStatus.CANCELLED)).toBe(false);
    // Disputes exist for that; a database write cannot unwind a physical handover.
    expect(canTransition(OrderStatus.PICKED_UP, OrderStatus.DISPUTED)).toBe(true);
  });

  it('routes an out-of-tolerance handover through buyer approval', () => {
    expect(canTransition(OrderStatus.READY_FOR_PICKUP, OrderStatus.PENDING_ADJUSTMENT)).toBe(true);
    expect(canTransition(OrderStatus.PENDING_ADJUSTMENT, OrderStatus.PICKED_UP)).toBe(true);
    expect(canTransition(OrderStatus.PENDING_ADJUSTMENT, OrderStatus.CANCELLED)).toBe(true);
  });

  it('holds stock in exactly the pre-handover states', () => {
    expect(STOCK_HELD_STATUSES).not.toContain(OrderStatus.PICKED_UP);
    expect(STOCK_HELD_STATUSES).not.toContain(OrderStatus.COMPLETED);
    expect(STOCK_HELD_STATUSES).toContain(OrderStatus.PENDING);
    expect(STOCK_HELD_STATUSES).toContain(OrderStatus.READY_FOR_PICKUP);
  });

  it('keeps the wire enum and the server enum in step', () => {
    expect([...OrderStatusSchema.options].sort()).toEqual(Object.values(OrderStatus).sort());
  });
});

describe('cancellation matrix', () => {
  it('lets a buyer cancel freely before the seller starts work', () => {
    expect(cancelRule(OrderStatus.PENDING, CancelActor.BUYER)).toMatchObject({
      allowed: true,
      penalised: false,
      reasonRequired: false,
    });
  });

  it('asks the buyer for a reason once the seller is preparing', () => {
    expect(cancelRule(OrderStatus.PREPARING, CancelActor.BUYER).reasonRequired).toBe(true);
  });

  it('penalises a buyer who abandons goods already weighed and bagged', () => {
    expect(cancelRule(OrderStatus.READY_FOR_PICKUP, CancelActor.BUYER).penalised).toBe(true);
  });

  it('penalises a seller who cancels after accepting', () => {
    expect(cancelRule(OrderStatus.PENDING, CancelActor.SELLER).penalised).toBe(false);
    expect(cancelRule(OrderStatus.ACCEPTED, CancelActor.SELLER).penalised).toBe(true);
  });

  it('penalises nobody for a rejected weight adjustment', () => {
    // The goods were not as ordered; that is not either party misbehaving.
    expect(cancelRule(OrderStatus.PENDING_ADJUSTMENT, CancelActor.BUYER)).toMatchObject({
      allowed: true,
      penalised: false,
    });
  });

  it('refuses everyone but an admin after pickup', () => {
    expect(cancelRule(OrderStatus.PICKED_UP, CancelActor.BUYER).allowed).toBe(false);
    expect(cancelRule(OrderStatus.PICKED_UP, CancelActor.SELLER).allowed).toBe(false);
    expect(cancelRule(OrderStatus.PICKED_UP, CancelActor.ADMIN).allowed).toBe(true);
    expect(cancelRule(OrderStatus.PICKED_UP, CancelActor.ADMIN).reasonRequired).toBe(true);
  });

  it('always demands a reason from a seller', () => {
    for (const status of [OrderStatus.PENDING, OrderStatus.ACCEPTED, OrderStatus.PREPARING]) {
      expect(cancelRule(status, CancelActor.SELLER).reasonRequired, status).toBe(true);
    }
  });
});

describe('group status', () => {
  it('stays active while any child is still in flight', () => {
    expect(deriveGroupStatus([OrderStatus.COMPLETED, OrderStatus.PREPARING])).toBe(GroupStatus.ACTIVE);
  });

  it('distinguishes fully from partially completed', () => {
    // One stall delivering and another cancelling is a normal outcome of a multi-shop basket
    // (ADR-0007), and the buyer should see exactly that.
    expect(deriveGroupStatus([OrderStatus.COMPLETED, OrderStatus.COMPLETED])).toBe(GroupStatus.COMPLETED);
    expect(deriveGroupStatus([OrderStatus.COMPLETED, OrderStatus.CANCELLED])).toBe(
      GroupStatus.PARTIALLY_COMPLETED,
    );
    expect(deriveGroupStatus([OrderStatus.CANCELLED, OrderStatus.EXPIRED])).toBe(GroupStatus.CANCELLED);
  });

  it('treats every terminal status as settled', () => {
    expect(deriveGroupStatus(TERMINAL_ORDER_STATUSES.slice())).not.toBe(GroupStatus.ACTIVE);
  });
});

describe('handover tolerance', () => {
  const ordered = 2500n; // 2.5 kg

  it('accepts a small shortfall within tolerance', () => {
    // 2.38 kg against 2.5 is 4.8% — inside a 10% tolerance.
    expect(isWithinTolerance(ordered, 2380n, 1000)).toBe(true);
  });

  it('rejects a shortfall beyond tolerance', () => {
    expect(isWithinTolerance(ordered, 2000n, 1000)).toBe(false);
  });

  it('treats over-delivery exactly like under-delivery', () => {
    // A seller handing over 30% more is charging 30% more than the buyer agreed to, which
    // needs the same approval step as giving them less.
    expect(isWithinTolerance(ordered, 3250n, 1000)).toBe(false);
    expect(isWithinTolerance(ordered, 2600n, 1000)).toBe(true);
  });

  it('handles a zero tolerance exactly', () => {
    expect(isWithinTolerance(ordered, 2500n, 0)).toBe(true);
    expect(isWithinTolerance(ordered, 2501n, 0)).toBe(false);
  });

  it('is exact at the boundary', () => {
    // 10% of 2.5 kg is exactly 250 g, and the boundary is inclusive.
    expect(isWithinTolerance(ordered, 2250n, 1000)).toBe(true);
    expect(isWithinTolerance(ordered, 2249n, 1000)).toBe(false);
  });
});
