/**
 * Order lifecycle (ORDER_SYSTEM.md).
 *
 * The transition table is the specification, not a convenience: every state change in the
 * system is checked against it, and an illegal move throws rather than being quietly
 * tolerated. It lives in the shared package because the API applies transitions on request
 * and the worker applies them on a timer, and two copies of a state machine is two state
 * machines.
 */

export const OrderStatus = {
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  PREPARING: 'PREPARING',
  READY_FOR_PICKUP: 'READY_FOR_PICKUP',
  PENDING_ADJUSTMENT: 'PENDING_ADJUSTMENT',
  PICKED_UP: 'PICKED_UP',
  COMPLETED: 'COMPLETED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
  DISPUTED: 'DISPUTED',
  REFUNDED: 'REFUNDED',
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  PENDING: [OrderStatus.ACCEPTED, OrderStatus.REJECTED, OrderStatus.EXPIRED, OrderStatus.CANCELLED],
  ACCEPTED: [OrderStatus.PREPARING, OrderStatus.CANCELLED],
  PREPARING: [OrderStatus.READY_FOR_PICKUP, OrderStatus.CANCELLED],
  READY_FOR_PICKUP: [
    OrderStatus.PENDING_ADJUSTMENT,
    OrderStatus.PICKED_UP,
    OrderStatus.CANCELLED,
  ],
  PENDING_ADJUSTMENT: [OrderStatus.PICKED_UP, OrderStatus.CANCELLED],
  PICKED_UP: [OrderStatus.COMPLETED, OrderStatus.DISPUTED],
  COMPLETED: [OrderStatus.DISPUTED],
  DISPUTED: [OrderStatus.COMPLETED, OrderStatus.REFUNDED],
  REJECTED: [],
  EXPIRED: [],
  CANCELLED: [],
  REFUNDED: [],
} as const;

export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = [
  OrderStatus.REJECTED,
  OrderStatus.EXPIRED,
  OrderStatus.CANCELLED,
  OrderStatus.REFUNDED,
  OrderStatus.COMPLETED,
];

/** Statuses in which stock is still held for the buyer and must be returned on cancellation. */
export const STOCK_HELD_STATUSES: readonly OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.ACCEPTED,
  OrderStatus.PREPARING,
  OrderStatus.READY_FOR_PICKUP,
  OrderStatus.PENDING_ADJUSTMENT,
];

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

export const CancelActor = {
  BUYER: 'BUYER',
  SELLER: 'SELLER',
  SYSTEM: 'SYSTEM',
  ADMIN: 'ADMIN',
} as const;
export type CancelActor = (typeof CancelActor)[keyof typeof CancelActor];

export interface CancelRule {
  allowed: boolean;
  /** Free cancellation, or one that counts against the actor's reliability. */
  penalised: boolean;
  reasonRequired: boolean;
}

/**
 * Who may cancel, from where, and at what cost (ORDER_SYSTEM.md "Cancellation matrix").
 *
 * Once goods have changed hands nobody cancels — the dispute flow exists for that. Allowing
 * a cancellation after pickup would mean unwinding a physical handover with a database write.
 */
const CANCEL_MATRIX: Readonly<Record<OrderStatus, Readonly<Record<CancelActor, CancelRule>>>> = {
  PENDING: {
    BUYER: { allowed: true, penalised: false, reasonRequired: false },
    SELLER: { allowed: true, penalised: false, reasonRequired: true },
    SYSTEM: { allowed: true, penalised: false, reasonRequired: true },
    ADMIN: { allowed: true, penalised: false, reasonRequired: true },
  },
  ACCEPTED: {
    BUYER: { allowed: true, penalised: false, reasonRequired: false },
    SELLER: { allowed: true, penalised: true, reasonRequired: true },
    SYSTEM: { allowed: true, penalised: false, reasonRequired: true },
    ADMIN: { allowed: true, penalised: false, reasonRequired: true },
  },
  PREPARING: {
    // The seller has already started work, so the buyer owes an explanation.
    BUYER: { allowed: true, penalised: false, reasonRequired: true },
    SELLER: { allowed: true, penalised: true, reasonRequired: true },
    SYSTEM: { allowed: true, penalised: false, reasonRequired: true },
    ADMIN: { allowed: true, penalised: false, reasonRequired: true },
  },
  READY_FOR_PICKUP: {
    // The goods are weighed, bagged and waiting; a buyer who walks away is a no-show.
    BUYER: { allowed: true, penalised: true, reasonRequired: true },
    SELLER: { allowed: true, penalised: false, reasonRequired: true },
    SYSTEM: { allowed: true, penalised: false, reasonRequired: true },
    ADMIN: { allowed: true, penalised: false, reasonRequired: true },
  },
  PENDING_ADJUSTMENT: {
    // Rejecting a weight change is not a penalty on either side: the goods were not as ordered.
    BUYER: { allowed: true, penalised: false, reasonRequired: false },
    SELLER: { allowed: true, penalised: false, reasonRequired: true },
    SYSTEM: { allowed: true, penalised: false, reasonRequired: true },
    ADMIN: { allowed: true, penalised: false, reasonRequired: true },
  },
  PICKED_UP: {
    BUYER: { allowed: false, penalised: false, reasonRequired: false },
    SELLER: { allowed: false, penalised: false, reasonRequired: false },
    SYSTEM: { allowed: false, penalised: false, reasonRequired: false },
    ADMIN: { allowed: true, penalised: false, reasonRequired: true },
  },
  COMPLETED: {
    BUYER: { allowed: false, penalised: false, reasonRequired: false },
    SELLER: { allowed: false, penalised: false, reasonRequired: false },
    SYSTEM: { allowed: false, penalised: false, reasonRequired: false },
    ADMIN: { allowed: true, penalised: false, reasonRequired: true },
  },
  REJECTED: emptyRow(),
  EXPIRED: emptyRow(),
  CANCELLED: emptyRow(),
  DISPUTED: emptyRow(),
  REFUNDED: emptyRow(),
};

function emptyRow(): Readonly<Record<CancelActor, CancelRule>> {
  const denied: CancelRule = { allowed: false, penalised: false, reasonRequired: false };
  return { BUYER: denied, SELLER: denied, SYSTEM: denied, ADMIN: denied };
}

export function cancelRule(status: OrderStatus, actor: CancelActor): CancelRule {
  return CANCEL_MATRIX[status][actor];
}

/**
 * Derives the buyer-facing status of an order group from its children (ADR-0007).
 *
 * Always computed, never authoritative: cancelling one shop's order does not cancel the
 * others, and no business rule reads this value.
 */
export const GroupStatus = {
  ACTIVE: 'ACTIVE',
  PARTIALLY_COMPLETED: 'PARTIALLY_COMPLETED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
} as const;
export type GroupStatus = (typeof GroupStatus)[keyof typeof GroupStatus];

export function deriveGroupStatus(children: readonly OrderStatus[]): GroupStatus {
  if (children.length === 0) return GroupStatus.CANCELLED;
  const allTerminal = children.every((status) => TERMINAL_ORDER_STATUSES.includes(status));
  if (!allTerminal) return GroupStatus.ACTIVE;

  const completed = children.filter((status) => status === OrderStatus.COMPLETED).length;
  if (completed === children.length) return GroupStatus.COMPLETED;
  if (completed > 0) return GroupStatus.PARTIALLY_COMPLETED;
  return GroupStatus.CANCELLED;
}

/**
 * Whether a confirmed quantity is within the product's handover tolerance (ADR-0006).
 *
 * Over-delivery is treated exactly like under-delivery. A seller who systematically hands
 * over more than ordered is charging more than the buyer agreed to, which needs the same
 * approval step as giving them less.
 */
export function isWithinTolerance(
  orderedMilli: bigint,
  confirmedMilli: bigint,
  toleranceBp: number,
): boolean {
  if (orderedMilli === 0n) return confirmedMilli === 0n;
  const diff = confirmedMilli > orderedMilli ? confirmedMilli - orderedMilli : orderedMilli - confirmedMilli;
  return diff * 10_000n <= orderedMilli * BigInt(toleranceBp);
}
