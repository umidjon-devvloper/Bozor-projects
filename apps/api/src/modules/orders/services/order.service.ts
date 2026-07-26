import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import { AppError, ErrorCode, notFound } from '@bozorlar/errors';
import type { Logger } from '@bozorlar/logger';
import type { Money} from '@bozorlar/money';
import { Quantity } from '@bozorlar/money';
import {
  CancelActor,
  OrderStatus,
  STOCK_HELD_STATUSES,
  canTransition,
  cancelRule,
  isWithinTolerance,
} from '@bozorlar/domain';
import { ActorType, AuditSeverity, type LocalizedText } from '@bozorlar/types';
import { outboxService } from '../../outbox/index.js';
import type { AuditService } from '../../audit/index.js';
import { reservationRepository, quoteRepository, ReservationStatus } from '../../checkout/index.js';
import { parseQuery, toPage, type Page, type QuerySpec } from '../../../http/query.js';
import {
  ACCEPT_WINDOW_MINUTES,
  ADJUSTMENT_RESPONSE_MINUTES,
  AUTO_COMPLETE_HOURS,
  AdjustmentStatus,
  CancelReasonCode,
  CommissionStatus,
  DISPUTE_WINDOW_HOURS,
  PICKUP_CODE_MAX_ATTEMPTS,
} from '../orders.constants.js';
import { orderRepository, type OrderRecord } from '../repositories/order.repository.js';
import { adjustmentRepository } from '../repositories/adjustment.repository.js';
import { nextGroupNumber, nextOrderNumber } from './orderNumber.service.js';
import { generatePickupCode, hashPickupCode, pickupCodeMatches } from './pickupCode.service.js';
import { OrderEvents } from '../events.js';

export const BUYER_ORDER_QUERY_SPEC: QuerySpec = {
  filters: [
    { field: 'status', type: 'string', operators: ['eq', 'in'] },
    { field: 'shopId', type: 'objectId', operators: ['eq'] },
    { field: 'createdAt', type: 'date', operators: ['gte', 'lte'] },
  ],
  sorts: [{ key: '-createdAt', sort: { createdAt: -1, _id: -1 } }],
  defaultSort: '-createdAt',
};

export const SELLER_ORDER_QUERY_SPEC: QuerySpec = {
  filters: [
    { field: 'shopId', type: 'objectId', operators: ['eq', 'in'] },
    { field: 'status', type: 'string', operators: ['eq', 'in'] },
    { field: 'hasAdjustment', type: 'boolean', operators: ['eq'] },
    { field: 'createdAt', type: 'date', operators: ['gte', 'lte'] },
  ],
  sorts: [
    { key: '-createdAt', sort: { createdAt: -1, _id: -1 } },
    { key: 'acceptDeadline', sort: { acceptDeadline: 1, _id: 1 } },
  ],
  defaultSort: '-createdAt',
};

/** Products as they stand right now, for verifying the quote is still honourable. */
export interface LiveProductLookup {
  findForCheckout(productIds: readonly string[]): Promise<Map<string, { price: Money; id: string }>>;
}

export interface BuyerLookup {
  snapshot(userId: string): Promise<{ name: string; phone: string } | null>;
}

/**
 * Everything an order freezes about the shop it was placed with.
 *
 * Fetched once at creation and copied in. A buyer opening a six-month-old order still needs
 * to see which stall they collected from, even if the shop has since been renamed, moved or
 * closed (DOMAIN_MODEL.md 1.5).
 */
export interface ShopSnapshotSource {
  ownerId: string;
  name: LocalizedText;
  slug: string;
  contactPhone: string;
  sectionCode: string | null;
  stallNo: string | null;
  marketId: string;
  marketName: LocalizedText;
  districtId: string;
  regionId: string;
}

export interface ShopSnapshotLookup {
  forOrder(shopId: string): Promise<ShopSnapshotSource | null>;
}

export interface Actor {
  userId: string;
  shopIds: readonly string[];
}

export function createOrderService(deps: {
  products: LiveProductLookup;
  buyers: BuyerLookup;
  shops: ShopSnapshotLookup;
  audit: AuditService;
  logger: Logger;
}) {
  const { products, buyers, shops, audit, logger } = deps;

  function assertBuyer(order: OrderRecord, actor: Actor): void {
    if (order.buyerId !== actor.userId) {
      throw notFound('Order', `PERM_SCOPE_DENIED user=${actor.userId} order=${order.id}`);
    }
  }

  function assertShopMember(order: OrderRecord, actor: Actor): void {
    if (!actor.shopIds.includes(order.shopId)) {
      throw notFound('Order', `PERM_SCOPE_DENIED user=${actor.userId} order=${order.id}`);
    }
  }

  function assertTransition(from: OrderStatus, to: OrderStatus): void {
    if (!canTransition(from, to)) {
      throw new AppError(ErrorCode.ORDER_INVALID_TRANSITION, {
        detail: `An order cannot move from ${from} to ${to}`,
        params: { from, to },
      });
    }
  }

  /**
   * Applies a transition and records the event, in one transaction.
   *
   * Every lifecycle method funnels through here so that the guard, the write, the history
   * entry and the outbox event cannot drift apart or be forgotten individually.
   */
  async function move(
    order: OrderRecord,
    to: OrderStatus,
    input: {
      patch?: Record<string, unknown>;
      actor: string;
      by: string | null;
      reasonCode?: CancelReasonCode | null;
      reason?: string | null;
      event: string;
      payload?: Record<string, unknown>;
      beforeCommit?: (session: mongoose.ClientSession) => Promise<void>;
    },
  ): Promise<OrderRecord> {
    assertTransition(order.status, to);

    const session = await mongoose.startSession();
    try {
      return await session.withTransaction(async () => {
        if (input.beforeCommit) await input.beforeCommit(session);

        const next = await orderRepository.transition(
          order.id,
          order.status,
          to,
          input.patch ?? {},
          {
            from: order.status,
            to,
            by: input.by ? new mongoose.Types.ObjectId(input.by) : null,
            actor: input.actor,
            reasonCode: input.reasonCode ?? null,
            reason: input.reason ?? null,
          },
          session,
        );
        if (!next) {
          // Somebody else moved it first — a seller accepting as the sweeper expires it.
          throw new AppError(ErrorCode.ORDER_INVALID_TRANSITION, {
            detail: 'This order changed while your request was being processed',
          });
        }

        await orderRepository.refreshGroupStatus(order.groupId, session);
        await outboxService.publish(
          {
            type: input.event,
            aggregateType: 'order',
            aggregateId: order.id,
            payload: {
              orderId: order.id,
              orderNo: order.orderNo,
              shopId: order.shopId,
              buyerId: order.buyerId,
              ...(input.payload ?? {}),
            },
            actorId: input.by,
            actorType: input.actor === 'SYSTEM' ? ActorType.SYSTEM : ActorType.USER,
          },
          session,
        );
        return next;
      });
    } finally {
      await session.endSession();
    }
  }

  /** Returns held stock and closes the reservations. Used by every cancelling path. */
  async function releaseStock(order: OrderRecord, session: mongoose.ClientSession): Promise<void> {
    if (!STOCK_HELD_STATUSES.includes(order.status)) return;
    const held = await reservationRepository.findActiveByHolder(order.id, session);
    // Claim before releasing — the same reasoning as `releaseHolds` in checkout and the two
    // sweepers. Every cancelling path reaches here, and the reservation sweeper can be
    // expiring the very same holds on its own clock.
    for (const reservation of held) {
      const claimed = await reservationRepository.claimForRelease(
        reservation.id,
        ReservationStatus.RELEASED,
        session,
      );
      if (!claimed) continue;

      await reservationRepository.releaseHold(
        reservation.productId,
        Quantity.of(reservation.qtyMilli, 'unit'),
        session,
      );
    }
  }

  return {
    /**
     * Turns a quote into an order group and one order per shop.
     *
     * The quote's content hash is recomputed against live products first. A mismatch means a
     * price moved between the offer and the tap, and the buyer is re-quoted rather than
     * charged a figure they never saw (CART_CHECKOUT.md).
     */
    async createFromQuote(input: {
      quoteId: string;
      buyerId: string;
      note?: string | undefined;
    }): Promise<{ groupId: string; groupNo: string; orders: OrderRecord[] }> {
      const quote = await quoteRepository.findByQuoteId(input.quoteId);
      if (!quote) throw notFound('Quote');
      if (quote.buyerId !== input.buyerId) {
        throw notFound('Quote', `PERM_SCOPE_DENIED user=${input.buyerId}`);
      }
      if (quote.status !== 'ACTIVE') {
        throw new AppError(ErrorCode.CHECKOUT_QUOTE_EXPIRED, {
          detail: `This quote is no longer valid (${quote.status.toLowerCase()})`,
        });
      }
      if (quote.expiresAt.getTime() < Date.now()) {
        throw new AppError(ErrorCode.CHECKOUT_QUOTE_EXPIRED, {
          detail: 'This quote has expired; please review your basket again',
        });
      }

      const productIds = quote.groups.flatMap((group) =>
        group.lines.map((line) => line.productId.toString()),
      );
      const live = await products.findForCheckout(productIds);

      const changed: Array<{ productId: string; from: string; to: string }> = [];
      for (const group of quote.groups) {
        for (const line of group.lines) {
          const current = live.get(line.productId.toString());
          if (!current) {
            changed.push({ productId: line.productId.toString(), from: line.unitPrice.toString(), to: 'gone' });
            continue;
          }
          if (current.price.minor !== line.unitPrice) {
            changed.push({
              productId: line.productId.toString(),
              from: line.unitPrice.toString(),
              to: current.price.toStorage(),
            });
          }
        }
      }
      if (changed.length > 0) {
        // The client re-quotes and shows the difference. Issuing a replacement quote from
        // inside a failed request would reserve stock again on an error path.
        throw new AppError(ErrorCode.CHECKOUT_QUOTE_STALE, {
          detail: 'Prices changed after this quote was issued; please review and confirm again',
          extra: { changed },
        });
      }

      const buyer = await buyers.snapshot(input.buyerId);
      if (!buyer) throw notFound('Buyer');

      const now = new Date();
      const acceptDeadline = new Date(now.getTime() + ACCEPT_WINDOW_MINUTES * 60 * 1000);

      const session = await mongoose.startSession();
      let result: { groupId: string; groupNo: string; orders: OrderRecord[] };
      try {
        result = await session.withTransaction(async () => {
          const groupNo = await nextGroupNumber(now, session);
          const groupTotals = {
            items: quote.grandTotal,
            discount: 0n,
            delivery: 0n,
            grand: quote.grandTotal,
          };
          const groupId = await orderRepository.createGroup(
            {
              groupNo,
              buyerId: new mongoose.Types.ObjectId(input.buyerId),
              orderIds: [],
              quoteId: quote.quoteId,
              paymentMode: quote.paymentMode,
              paymentId: null,
              totals: groupTotals,
              buyerSnapshot: buyer,
            },
            session,
          );

          const created: OrderRecord[] = [];
          for (const group of quote.groups) {
            const shop = await shops.forOrder(group.shopId.toString());
            if (!shop) throw notFound('Shop');

            const orderNo = await nextOrderNumber(now, session);
            const order = await orderRepository.createOrder(
              {
                orderNo,
                groupId: new mongoose.Types.ObjectId(groupId),
                buyerId: new mongoose.Types.ObjectId(input.buyerId),
                shopId: group.shopId,
                // Snapshot, not a reference: transferring a shop must not move the liability
                // for orders taken under the previous owner.
                sellerId: new mongoose.Types.ObjectId(shop.ownerId),
                marketId: new mongoose.Types.ObjectId(shop.marketId),
                districtId: new mongoose.Types.ObjectId(shop.districtId),
                regionId: new mongoose.Types.ObjectId(shop.regionId),
                shopSnapshot: {
                  name: shop.name,
                  slug: shop.slug,
                  phone: shop.contactPhone,
                  sectionCode: shop.sectionCode,
                  stallNo: shop.stallNo,
                  marketName: shop.marketName,
                },
                buyerSnapshot: buyer,
                lines: group.lines.map((line) => ({
                  lineId: line.lineId,
                  productId: line.productId,
                  productName: line.productName,
                  productSlug: line.productSlug,
                  imageKey: line.imageKey,
                  unit: line.unit,
                  unitPrice: line.unitPrice,
                  orderedQtyMilli: line.qtyMilli,
                  confirmedQtyMilli: null,
                  tolerancePercent: line.tolerancePercent,
                  lineTotal: line.lineTotal,
                  adjustmentStatus: AdjustmentStatus.NONE,
                })),
                status: OrderStatus.PENDING,
                paymentMode: quote.paymentMode,
                fulfilmentType: 'PICKUP',
                totals: {
                  items: group.subtotal,
                  adjustment: 0n,
                  discount: 0n,
                  delivery: 0n,
                  grand: group.total,
                },
                commission: {
                  // Owned by the wallet module (Phase 6); charged off `order.completed`.
                  ruleId: null,
                  percentBp: null,
                  amount: null,
                  status: CommissionStatus.PENDING,
                  journalEntryId: null,
                  chargedAt: null,
                  failureReason: null,
                },
                pickupCodeHash: null,
                pickupWindow: { from: group.pickupFrom, to: group.pickupTo },
                acceptDeadline,
                autoCompleteAt: null,
                disputeDeadline: null,
                cancelledBy: null,
                cancelReasonCode: null,
                cancelReason: null,
                cancelPenalised: false,
                hasAdjustment: false,
                note: input.note ?? null,
              } as never,
              session,
            );
            created.push(order);

            // The quote's holds become this order's holds, then convert to a committed stock
            // decrement. Stock leaves the shelf here, not at completion.
            for (const line of group.lines) {
              await reservationRepository.commitHold(
                line.productId.toString(),
                Quantity.of(line.qtyMilli, line.unit),
                session,
              );
            }

            await outboxService.publish(
              {
                type: OrderEvents.CREATED,
                aggregateType: 'order',
                aggregateId: order.id,
                payload: {
                  orderId: order.id,
                  orderNo,
                  groupId,
                  shopId: group.shopId.toString(),
                  buyerId: input.buyerId,
                  total: group.total.toString(),
                  acceptDeadline: acceptDeadline.toISOString(),
                },
                actorId: input.buyerId,
                actorType: ActorType.USER,
              },
              session,
            );
          }

          const heldReservations = await reservationRepository.findActiveByHolder(quote.quoteId);
          await reservationRepository.markStatus(
            heldReservations.map((reservation) => reservation.id),
            ReservationStatus.COMMITTED,
            session,
          );

          await orderRepository.attachOrdersToGroup(
            groupId,
            created.map((order) => order.id),
            session,
          );
          await quoteRepository.consume(quote.quoteId, groupId, session);
          return { groupId, groupNo, orders: created };
        });
      } finally {
        await session.endSession();
      }

      logger.info(
        { groupId: result.groupId, orders: result.orders.length, buyerId: input.buyerId },
        'order group created',
      );
      return result;
    },

    async getForBuyer(orderId: string, actor: Actor): Promise<OrderRecord> {
      const order = await orderRepository.findById(orderId);
      if (!order) throw notFound('Order');
      assertBuyer(order, actor);
      return order;
    },

    async getForSeller(orderId: string, actor: Actor): Promise<OrderRecord> {
      const order = await orderRepository.findById(orderId);
      if (!order) throw notFound('Order');
      assertShopMember(order, actor);
      return order;
    },

    async listForBuyer(query: Record<string, unknown>, buyerId: string): Promise<Page<OrderRecord>> {
      const parsed = parseQuery(query, BUYER_ORDER_QUERY_SPEC);
      const rows = await orderRepository.list(parsed, { buyerId: new mongoose.Types.ObjectId(buyerId) });
      const page = toPage(rows as unknown as Record<string, unknown>[], parsed);
      return {
        items: page.items as unknown as OrderRecord[],
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      };
    },

    async listForSeller(query: Record<string, unknown>, actor: Actor): Promise<Page<OrderRecord>> {
      if (actor.shopIds.length === 0) return { items: [], nextCursor: null, hasMore: false };
      const parsed = parseQuery(query, SELLER_ORDER_QUERY_SPEC);
      const rows = await orderRepository.list(parsed, {
        shopId: { $in: actor.shopIds.map((id) => new mongoose.Types.ObjectId(id)) },
      });
      const page = toPage(rows as unknown as Record<string, unknown>[], parsed);
      return {
        items: page.items as unknown as OrderRecord[],
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      };
    },

    async getGroup(groupId: string, actor: Actor) {
      const group = await orderRepository.findGroupById(groupId);
      if (!group) throw notFound('Order group');
      if (group.buyerId !== actor.userId) throw notFound('Order group', 'PERM_SCOPE_DENIED');
      return { group, orders: await orderRepository.findByGroup(groupId) };
    },

    async accept(orderId: string, actor: Actor): Promise<OrderRecord> {
      const order = await this.getForSeller(orderId, actor);
      if (order.acceptDeadline && order.acceptDeadline.getTime() < Date.now()) {
        throw new AppError(ErrorCode.ORDER_ACCEPT_WINDOW_EXPIRED, {
          detail: 'The window to accept this order has passed',
        });
      }
      return move(order, OrderStatus.ACCEPTED, {
        patch: { acceptDeadline: null },
        actor: 'SELLER',
        by: actor.userId,
        event: OrderEvents.ACCEPTED,
      });
    },

    async reject(
      orderId: string,
      actor: Actor,
      input: { reasonCode: CancelReasonCode; reason: string },
    ): Promise<OrderRecord> {
      const order = await this.getForSeller(orderId, actor);
      return move(order, OrderStatus.REJECTED, {
        patch: {
          cancelledBy: CancelActor.SELLER,
          cancelReasonCode: input.reasonCode,
          cancelReason: input.reason,
        },
        actor: 'SELLER',
        by: actor.userId,
        reasonCode: input.reasonCode,
        reason: input.reason,
        event: OrderEvents.REJECTED,
        beforeCommit: (session) => releaseStock(order, session),
      });
    },

    async startPreparing(orderId: string, actor: Actor): Promise<OrderRecord> {
      const order = await this.getForSeller(orderId, actor);
      return move(order, OrderStatus.PREPARING, {
        actor: 'SELLER',
        by: actor.userId,
        event: OrderEvents.PREPARING,
      });
    },

    /**
     * Marks the goods ready and issues the pickup code.
     *
     * The plaintext code is returned exactly once, to the buyer, through their own endpoint.
     * Only the hash is stored, so reading the database cannot get you somebody's shopping.
     */
    async markReady(orderId: string, actor: Actor): Promise<OrderRecord> {
      const order = await this.getForSeller(orderId, actor);
      const code = generatePickupCode();
      const updated = await move(order, OrderStatus.READY_FOR_PICKUP, {
        patch: { pickupCodeHash: hashPickupCode(code), pickupCodeAttempts: 0 },
        actor: 'SELLER',
        by: actor.userId,
        event: OrderEvents.READY_FOR_PICKUP,
      });
      return updated;
    },

    /** The buyer's copy of the code. Regenerating it is not possible; only a reset is. */
    async pickupCode(orderId: string, actor: Actor): Promise<{ code: string }> {
      const order = await this.getForBuyer(orderId, actor);
      if (order.status !== OrderStatus.READY_FOR_PICKUP && order.status !== OrderStatus.PENDING_ADJUSTMENT) {
        throw new AppError(ErrorCode.ORDER_INVALID_TRANSITION, {
          detail: 'A pickup code exists only once the order is ready',
        });
      }
      // The stored hash cannot be reversed, so the code is reissued and re-hashed. The seller
      // verifies against whatever is current, so an old screenshot stops working.
      const code = generatePickupCode();
      await orderRepository.updateOrder(orderId, { pickupCodeHash: hashPickupCode(code) });
      return { code };
    },

    async verifyPickup(orderId: string, actor: Actor, code: string): Promise<OrderRecord> {
      const order = await this.getForSeller(orderId, actor);
      if (order.pickupCodeAttempts >= PICKUP_CODE_MAX_ATTEMPTS) {
        throw new AppError(ErrorCode.ORDER_PICKUP_CODE_ATTEMPTS_EXCEEDED, {
          detail: 'Too many incorrect codes; ask the buyer to refresh theirs',
        });
      }
      const storedHash = await orderRepository.pickupCodeHash(orderId);
      if (!storedHash || !pickupCodeMatches(code, storedHash)) {
        const session = await mongoose.startSession();
        try {
          await session.withTransaction(async () => {
            await orderRepository.incrementPickupAttempts(orderId, session);
          });
        } finally {
          await session.endSession();
        }
        throw new AppError(ErrorCode.ORDER_PICKUP_CODE_INVALID, {
          detail: 'That code does not match',
          params: { attemptsRemaining: PICKUP_CODE_MAX_ATTEMPTS - order.pickupCodeAttempts - 1 },
        });
      }

      const now = new Date();
      return move(order, OrderStatus.PICKED_UP, {
        patch: {
          pickupCodeHash: null,
          autoCompleteAt: new Date(now.getTime() + AUTO_COMPLETE_HOURS * 60 * 60 * 1000),
        },
        actor: 'SELLER',
        by: actor.userId,
        event: OrderEvents.PICKED_UP,
      });
    },

    async confirm(orderId: string, actor: Actor): Promise<OrderRecord> {
      const order = await this.getForBuyer(orderId, actor);
      return this.complete(order, { by: actor.userId, actor: 'BUYER' });
    },

    /**
     * Completion. The event emitted here is what the wallet module charges commission from
     * (COMMISSION_SPEC.md "Timing").
     */
    async complete(order: OrderRecord, by: { by: string | null; actor: string }): Promise<OrderRecord> {
      const now = new Date();
      const completed = await move(order, OrderStatus.COMPLETED, {
        patch: { disputeDeadline: new Date(now.getTime() + DISPUTE_WINDOW_HOURS * 60 * 60 * 1000) },
        actor: by.actor,
        by: by.by,
        event: OrderEvents.COMPLETED,
        payload: {
          sellerId: order.sellerId,
          total: order.totals.grand.toStorage(),
          completedAt: now.toISOString(),
        },
      });
      await audit.record({
        actorId: by.by,
        actorType: by.actor === 'SYSTEM' ? ActorType.SYSTEM : ActorType.USER,
        action: 'order.completed',
        targetType: 'order',
        targetId: order.id,
        after: { orderNo: order.orderNo, total: order.totals.grand.toStorage() },
      });
      return completed;
    },

    async cancel(
      orderId: string,
      actor: Actor,
      by: CancelActor,
      input: { reasonCode: CancelReasonCode; reason?: string | undefined },
    ): Promise<OrderRecord> {
      const order =
        by === CancelActor.BUYER
          ? await this.getForBuyer(orderId, actor)
          : await this.getForSeller(orderId, actor);

      const rule = cancelRule(order.status, by);
      if (!rule.allowed) {
        throw new AppError(ErrorCode.ORDER_CANCEL_NOT_ALLOWED, {
          detail: `An order in ${order.status} cannot be cancelled by the ${by.toLowerCase()}`,
        });
      }
      if (rule.reasonRequired && !input.reason) {
        throw new AppError(ErrorCode.ORDER_CANCEL_REASON_REQUIRED, {
          detail: 'A reason is required to cancel at this stage',
        });
      }

      const cancelled = await move(order, OrderStatus.CANCELLED, {
        patch: {
          cancelledBy: by,
          cancelReasonCode: input.reasonCode,
          cancelReason: input.reason ?? null,
          cancelPenalised: rule.penalised,
        },
        actor: by,
        by: actor.userId,
        reasonCode: input.reasonCode,
        reason: input.reason ?? null,
        event: OrderEvents.CANCELLED,
        payload: { cancelledBy: by, penalised: rule.penalised },
        beforeCommit: (session) => releaseStock(order, session),
      });

      await audit.record({
        actorId: actor.userId,
        actorType: ActorType.USER,
        action: 'order.cancelled',
        targetType: 'order',
        targetId: orderId,
        reason: input.reason ?? null,
        after: { cancelledBy: by, penalised: rule.penalised },
        severity: rule.penalised ? AuditSeverity.WARNING : AuditSeverity.INFO,
      });
      return cancelled;
    },

    /**
     * Records the weights taken at handover (ADR-0006).
     *
     * Within tolerance the order proceeds straight to pickup at the corrected total. Beyond
     * it, the buyer has to agree — because a 30% heavier cut of meat is a materially
     * different purchase from the one they made.
     */
    async proposeAdjustment(
      orderId: string,
      actor: Actor,
      lines: ReadonlyArray<{ lineId: string; confirmedQty: string }>,
    ): Promise<{ order: OrderRecord; requiresBuyerApproval: boolean }> {
      const order = await this.getForSeller(orderId, actor);
      if (order.status !== OrderStatus.READY_FOR_PICKUP) {
        throw new AppError(ErrorCode.ORDER_INVALID_TRANSITION, {
          detail: 'Weights can only be recorded once the order is ready for pickup',
        });
      }
      if (order.hasAdjustment) {
        throw new AppError(ErrorCode.ORDER_ADJUSTMENT_PENDING, {
          detail: 'An adjustment is already awaiting the buyer',
        });
      }

      const byLineId = new Map(order.lines.map((line) => [line.lineId, line]));
      const adjustmentLines: Array<{
        lineId: string;
        orderedQtyMilli: bigint;
        proposedQtyMilli: bigint;
        deltaBp: number;
        oldLineTotal: bigint;
        newLineTotal: bigint;
      }> = [];
      let withinTolerance = true;

      for (const input of lines) {
        const line = byLineId.get(input.lineId);
        if (!line) throw notFound('Order line');

        const confirmed = Quantity.of(input.confirmedQty, line.unit);
        const deltaBp = confirmed.deltaBpFrom(line.orderedQty);
        const newLineTotal = confirmed.multiplyPrice(line.unitPrice);

        if (!isWithinTolerance(line.orderedQty.milli, confirmed.milli, line.tolerancePercent)) {
          withinTolerance = false;
        }
        adjustmentLines.push({
          lineId: line.lineId,
          orderedQtyMilli: line.orderedQty.milli,
          proposedQtyMilli: confirmed.milli,
          deltaBp,
          oldLineTotal: line.lineTotal.minor,
          newLineTotal: newLineTotal.minor,
        });
      }

      const newItemsTotal = order.lines.reduce((sum, line) => {
        const proposal = adjustmentLines.find((candidate) => candidate.lineId === line.lineId);
        return sum + (proposal ? proposal.newLineTotal : line.lineTotal.minor);
      }, 0n);
      const oldTotal = order.totals.items.minor;

      const now = new Date();
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          await adjustmentRepository.create(
            {
              orderId: new mongoose.Types.ObjectId(order.id),
              orderNo: order.orderNo,
              shopId: new mongoose.Types.ObjectId(order.shopId),
              buyerId: new mongoose.Types.ObjectId(order.buyerId),
              lines: adjustmentLines,
              oldTotal,
              newTotal: newItemsTotal,
              requestedBy: new mongoose.Types.ObjectId(actor.userId),
              expiresAt: new Date(now.getTime() + ADJUSTMENT_RESPONSE_MINUTES * 60 * 1000),
            },
            session,
          );
          await outboxService.publish(
            {
              type: withinTolerance ? OrderEvents.ADJUSTMENT_APPROVED : OrderEvents.ADJUSTMENT_REQUESTED,
              aggregateType: 'order',
              aggregateId: order.id,
              payload: {
                orderId: order.id,
                orderNo: order.orderNo,
                buyerId: order.buyerId,
                oldTotal: oldTotal.toString(),
                newTotal: newItemsTotal.toString(),
                requiresApproval: !withinTolerance,
              },
              actorId: actor.userId,
              actorType: ActorType.USER,
            },
            session,
          );
        });
      } finally {
        await session.endSession();
      }

      if (withinTolerance) {
        const applied = await this.applyAdjustment(order.id, adjustmentLines, AdjustmentStatus.AUTO_APPROVED);
        return { order: applied, requiresBuyerApproval: false };
      }

      const pending = await move(order, OrderStatus.PENDING_ADJUSTMENT, {
        patch: { hasAdjustment: true },
        actor: 'SELLER',
        by: actor.userId,
        event: OrderEvents.ADJUSTMENT_REQUESTED,
      });
      return { order: pending, requiresBuyerApproval: true };
    },

    /** Writes confirmed quantities and the corrected totals onto the order. */
    async applyAdjustment(
      orderId: string,
      lines: ReadonlyArray<{ lineId: string; proposedQtyMilli: bigint; newLineTotal: bigint }>,
      status: AdjustmentStatus,
    ): Promise<OrderRecord> {
      const order = await orderRepository.findById(orderId);
      if (!order) throw notFound('Order');

      const updatedLines = order.lines.map((line) => {
        const proposal = lines.find((candidate) => candidate.lineId === line.lineId);
        const confirmed = proposal?.proposedQtyMilli ?? line.orderedQty.milli;
        const lineTotal = proposal?.newLineTotal ?? line.lineTotal.minor;
        return {
          lineId: line.lineId,
          productId: new mongoose.Types.ObjectId(line.productId),
          productName: line.productName,
          productSlug: line.productSlug,
          imageKey: line.imageKey,
          unit: line.unit,
          unitPrice: line.unitPrice.minor,
          orderedQtyMilli: line.orderedQty.milli,
          confirmedQtyMilli: confirmed,
          tolerancePercent: line.tolerancePercent,
          lineTotal,
          adjustmentStatus: proposal ? status : AdjustmentStatus.NONE,
        };
      });

      const itemsTotal = updatedLines.reduce((sum, line) => sum + line.lineTotal, 0n);
      const updated = await orderRepository.updateOrder(orderId, {
        lines: updatedLines,
        'totals.items': itemsTotal,
        'totals.adjustment': itemsTotal - order.totals.items.minor,
        'totals.grand': itemsTotal,
        hasAdjustment: true,
      });
      if (!updated) throw notFound('Order');
      return updated;
    },

    async respondToAdjustment(
      orderId: string,
      actor: Actor,
      approved: boolean,
    ): Promise<OrderRecord> {
      const order = await this.getForBuyer(orderId, actor);
      if (order.status !== OrderStatus.PENDING_ADJUSTMENT) {
        throw new AppError(ErrorCode.ORDER_ADJUSTMENT_NOT_FOUND, {
          detail: 'There is no adjustment awaiting your response',
        });
      }
      const unit = order.lines[0]?.unit ?? 'unit';
      const adjustment = await adjustmentRepository.findPendingForOrder(orderId, unit);
      if (!adjustment) throw new AppError(ErrorCode.ORDER_ADJUSTMENT_NOT_FOUND, { detail: 'No pending adjustment' });
      if (adjustment.expiresAt.getTime() < Date.now()) {
        throw new AppError(ErrorCode.ORDER_ADJUSTMENT_EXPIRED, {
          detail: 'The window to respond to this adjustment has passed',
        });
      }

      if (!approved) {
        return this.cancel(orderId, actor, CancelActor.BUYER, {
          reasonCode: CancelReasonCode.ADJUSTMENT_REJECTED,
        });
      }

      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const resolved = await adjustmentRepository.resolve(adjustment.id, AdjustmentStatus.APPROVED, session);
          if (!resolved) {
            throw new AppError(ErrorCode.RESOURCE_CONFLICT, {
              detail: 'This adjustment was already answered',
            });
          }
        });
      } finally {
        await session.endSession();
      }

      await this.applyAdjustment(
        orderId,
        adjustment.lines.map((line) => ({
          lineId: line.lineId,
          proposedQtyMilli: line.proposedQty.milli,
          newLineTotal: line.newLineTotal.minor,
        })),
        AdjustmentStatus.APPROVED,
      );

      const refreshed = await orderRepository.findById(orderId);
      if (!refreshed) throw notFound('Order');
      return move(refreshed, OrderStatus.PICKED_UP, {
        patch: {
          pickupCodeHash: null,
          autoCompleteAt: new Date(Date.now() + AUTO_COMPLETE_HOURS * 60 * 60 * 1000),
        },
        actor: 'BUYER',
        by: actor.userId,
        event: OrderEvents.ADJUSTMENT_APPROVED,
      });
    },

    /** Used by the worker's timers. */
    async expire(order: OrderRecord): Promise<OrderRecord> {
      return move(order, OrderStatus.EXPIRED, {
        patch: {
          cancelledBy: CancelActor.SYSTEM,
          cancelReasonCode: CancelReasonCode.ACCEPT_WINDOW_EXPIRED,
          cancelReason: 'The seller did not respond within the accept window',
        },
        actor: 'SYSTEM',
        by: null,
        reasonCode: CancelReasonCode.ACCEPT_WINDOW_EXPIRED,
        event: OrderEvents.EXPIRED,
        beforeCommit: (session) => releaseStock(order, session),
      });
    },

    async autoComplete(order: OrderRecord): Promise<OrderRecord> {
      return this.complete(order, { by: null, actor: 'SYSTEM' });
    },

    contentDigest(value: string): string {
      return createHash('sha256').update(value).digest('hex');
    },
  };
}

export type OrderService = ReturnType<typeof createOrderService>;
