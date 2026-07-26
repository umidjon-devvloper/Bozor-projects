import mongoose from 'mongoose';
import { AppError, ErrorCode, notFound } from '@bozorlar/errors';
import type { Logger } from '@bozorlar/logger';
import { Money } from '@bozorlar/money';
import type {
  DisputeOutcome} from '@bozorlar/domain';
import {
  DisputeStatus,
  OrderStatus,
  canTransitionDispute,
  commissionReversalFor,
  refundAmountFor,
  reliabilityAfter,
} from '@bozorlar/domain';
import { ActorType, AuditSeverity } from '@bozorlar/types';
import { outboxService } from '../../outbox/index.js';
import type { AuditService } from '../../audit/index.js';
import { MediaPurpose, type MediaService } from '../../media/index.js';
import { parseQuery, toPage, type Page, type QuerySpec } from '../../../http/query.js';
import { disputeRepository, type DisputeRecord } from '../repositories/dispute.repository.js';
import {
  MAX_EVIDENCE_PHOTOS,
  SELLER_RESPONSE_HOURS,
  SettlementMethod,
  type DisputeReason,
} from '../disputes.constants.js';
import { DisputeEvents } from '../events.js';

export const DISPUTE_QUERY_SPEC: QuerySpec = {
  filters: [
    { field: 'status', type: 'string', operators: ['eq', 'in'] },
    { field: 'shopId', type: 'objectId', operators: ['eq'] },
    { field: 'reason', type: 'string', operators: ['eq', 'in'] },
    { field: 'createdAt', type: 'date', operators: ['gte', 'lte'] },
  ],
  sorts: [
    { key: 'createdAt', sort: { createdAt: 1, _id: 1 } },
    { key: '-createdAt', sort: { createdAt: -1, _id: -1 } },
  ],
  defaultSort: 'createdAt',
};

export interface DisputableOrder {
  id: string;
  orderNo: string;
  buyerId: string;
  sellerId: string;
  shopId: string;
  status: OrderStatus;
  paymentMode: 'CASH_ON_PICKUP' | 'PREPAID_ONLINE';
  totalMinor: bigint;
  disputeDeadline: Date | null;
  commissionAmountMinor: bigint | null;
}

export interface OrderDisputePort {
  forDispute(orderId: string): Promise<DisputableOrder | null>;
  markDisputed(
    orderId: string,
    from: OrderStatus,
    buyerId: string,
    session: mongoose.ClientSession,
  ): Promise<boolean>;
  settle(
    orderId: string,
    refunded: boolean,
    moderatorId: string,
    reason: string,
    session: mongoose.ClientSession,
  ): Promise<boolean>;
}

/** Reverses commission on the ledger. Supplied by the wallet module. */
export interface CommissionReverser {
  reverseForOrder(
    orderId: string,
    reason: string,
    actorId: string,
    partialMinor?: bigint,
  ): Promise<Money>;
}

export interface Actor {
  userId: string;
  shopIds: readonly string[];
}

export function createDisputeService(deps: {
  orders: OrderDisputePort;
  commission: CommissionReverser;
  media: MediaService;
  audit: AuditService;
  logger: Logger;
}) {
  const { orders, commission, media, audit, logger } = deps;

  async function resolveEvidence(keys: readonly string[], ownerId: string) {
    if (keys.length === 0) return [];
    if (keys.length > MAX_EVIDENCE_PHOTOS) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        detail: `At most ${MAX_EVIDENCE_PHOTOS} pieces of evidence per submission`,
      });
    }
    const resolved = await media.resolveMany(keys);
    return keys.map((mediaKey) => {
      const asset = resolved.get(mediaKey);
      if (!asset) {
        throw new AppError(ErrorCode.MEDIA_UPLOAD_NOT_CONFIRMED, {
          detail: `Evidence ${mediaKey} has not been confirmed`,
        });
      }
      return {
        mediaKey,
        blurhash: asset.blurhash,
        uploadedBy: new mongoose.Types.ObjectId(ownerId),
        uploadedAt: new Date(),
      };
    });
  }

  return {
    /**
     * Raises a dispute.
     *
     * Only after the goods have changed hands: before that, the order can simply be cancelled,
     * and routing a cancellable order through arbitration would waste a moderator's time on
     * something the buyer can resolve with one tap (ORDER_SYSTEM.md).
     */
    async raise(input: {
      orderId: string;
      reason: DisputeReason;
      claim: string;
      claimedAmount?: string | undefined;
      evidence?: string[] | undefined;
      actor: Actor;
    }): Promise<DisputeRecord> {
      const order = await orders.forDispute(input.orderId);
      if (!order) throw notFound('Order');
      if (order.buyerId !== input.actor.userId) {
        throw notFound('Order', `PERM_SCOPE_DENIED user=${input.actor.userId}`);
      }
      if (order.status !== OrderStatus.PICKED_UP && order.status !== OrderStatus.COMPLETED) {
        throw new AppError(ErrorCode.DISPUTE_NOT_ELIGIBLE, {
          detail:
            order.status === OrderStatus.DISPUTED
              ? 'This order is already in dispute'
              : 'An order can be disputed only after you have collected it',
        });
      }
      if (order.disputeDeadline !== null && order.disputeDeadline.getTime() < Date.now()) {
        throw new AppError(ErrorCode.DISPUTE_WINDOW_CLOSED, {
          detail: 'The window to dispute this order has closed',
        });
      }
      if (await disputeRepository.findOpenForOrder(order.id)) {
        throw new AppError(ErrorCode.DISPUTE_ALREADY_OPEN, {
          detail: 'A dispute is already open for this order',
        });
      }

      const claimedMinor =
        input.claimedAmount === undefined ? null : Money.of(input.claimedAmount).minor;
      if (claimedMinor !== null && claimedMinor > order.totalMinor) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, {
          detail: 'You cannot claim more than the order total',
          errors: [{ field: 'claimedAmount', code: 'EXCEEDS_ORDER_TOTAL' }],
        });
      }

      const evidence = await resolveEvidence(input.evidence ?? [], input.actor.userId);
      const now = new Date();
      const disputeNo = `DSP-${now.toISOString().slice(2, 10).replace(/-/g, '')}-${Math.random()
        .toString(36)
        .slice(2, 8)
        .toUpperCase()}`;

      const session = await mongoose.startSession();
      let dispute: DisputeRecord;
      try {
        dispute = await session.withTransaction(async () => {
          const moved = await orders.markDisputed(order.id, order.status, input.actor.userId, session);
          if (!moved) {
            // The order changed underneath — most likely auto-completed a moment ago. Telling
            // the buyer to try again is honest; silently retrying against a different state
            // is not.
            throw new AppError(ErrorCode.DISPUTE_INVALID_TRANSITION, {
              detail: 'This order changed while your dispute was being raised; please try again',
            });
          }

          const created = await disputeRepository.create(
            {
              disputeNo,
              orderId: order.id,
              orderNo: order.orderNo,
              buyerId: order.buyerId,
              sellerId: order.sellerId,
              shopId: order.shopId,
              reason: input.reason,
              claim: input.claim.trim(),
              claimedAmountMinor: claimedMinor,
              orderTotalMinor: order.totalMinor,
              evidence,
              sellerResponseDeadline: new Date(now.getTime() + SELLER_RESPONSE_HOURS * 3_600_000),
            },
            session,
          );

          if (evidence.length > 0) {
            await media.attachToEntity({
              mediaKeys: evidence.map((item) => item.mediaKey),
              target: { type: 'dispute', id: created.id },
              expectedPurpose: MediaPurpose.DISPUTE_EVIDENCE,
              ownerId: input.actor.userId,
              session,
            });
          }

          await outboxService.publish(
            {
              type: DisputeEvents.RAISED,
              aggregateType: 'dispute',
              aggregateId: created.id,
              payload: {
                disputeId: created.id,
                disputeNo,
                orderId: order.id,
                orderNo: order.orderNo,
                sellerId: order.sellerId,
                buyerId: order.buyerId,
                reason: input.reason,
              },
              actorId: input.actor.userId,
              actorType: ActorType.USER,
            },
            session,
          );
          return created;
        });
      } finally {
        await session.endSession();
      }

      await audit.record({
        actorId: input.actor.userId,
        actorType: ActorType.USER,
        action: 'dispute.raised',
        targetType: 'dispute',
        targetId: dispute.id,
        after: { orderNo: order.orderNo, reason: input.reason },
        severity: AuditSeverity.WARNING,
      });
      logger.warn({ disputeId: dispute.id, orderNo: order.orderNo }, 'dispute raised');
      return dispute;
    },

    async get(disputeId: string, actor: Actor, privileged: boolean): Promise<DisputeRecord> {
      const dispute = await disputeRepository.findById(disputeId);
      if (!dispute) throw notFound('Dispute');
      const involved =
        dispute.buyerId === actor.userId || actor.shopIds.includes(dispute.shopId) || privileged;
      // Reported as missing rather than forbidden, so dispute ids cannot be probed.
      if (!involved) throw notFound('Dispute', `PERM_SCOPE_DENIED user=${actor.userId}`);
      return dispute;
    },

    async listForBuyer(query: Record<string, unknown>, buyerId: string): Promise<Page<DisputeRecord>> {
      const parsed = parseQuery(query, DISPUTE_QUERY_SPEC);
      const rows = await disputeRepository.list(parsed, {
        buyerId: new mongoose.Types.ObjectId(buyerId),
      });
      const page = toPage(rows as unknown as Record<string, unknown>[], parsed);
      return { items: page.items as unknown as DisputeRecord[], nextCursor: page.nextCursor, hasMore: page.hasMore };
    },

    async listForSeller(query: Record<string, unknown>, actor: Actor): Promise<Page<DisputeRecord>> {
      if (actor.shopIds.length === 0) return { items: [], nextCursor: null, hasMore: false };
      const parsed = parseQuery(query, DISPUTE_QUERY_SPEC);
      const rows = await disputeRepository.list(parsed, {
        shopId: { $in: actor.shopIds.map((id) => new mongoose.Types.ObjectId(id)) },
      });
      const page = toPage(rows as unknown as Record<string, unknown>[], parsed);
      return { items: page.items as unknown as DisputeRecord[], nextCursor: page.nextCursor, hasMore: page.hasMore };
    },

    async listForModeration(query: Record<string, unknown>): Promise<Page<DisputeRecord>> {
      const parsed = parseQuery(query, DISPUTE_QUERY_SPEC);
      const rows = await disputeRepository.list(parsed, {});
      const page = toPage(rows as unknown as Record<string, unknown>[], parsed);
      return { items: page.items as unknown as DisputeRecord[], nextCursor: page.nextCursor, hasMore: page.hasMore };
    },

    /**
     * The seller answers, which moves the case to a moderator.
     *
     * Answering does not settle anything: once a dispute is raised, only an arbitrator closes
     * it. Letting the parties settle privately would leave the platform unable to say what was
     * decided or why.
     */
    async respond(
      disputeId: string,
      input: { text: string; evidence?: string[] | undefined },
      actor: Actor,
    ): Promise<DisputeRecord> {
      const dispute = await disputeRepository.findById(disputeId);
      if (!dispute) throw notFound('Dispute');
      if (!actor.shopIds.includes(dispute.shopId)) {
        throw notFound('Dispute', `PERM_SCOPE_DENIED user=${actor.userId}`);
      }
      if (dispute.status !== DisputeStatus.OPEN && dispute.status !== DisputeStatus.UNDER_REVIEW) {
        throw new AppError(ErrorCode.DISPUTE_INVALID_TRANSITION, {
          detail: 'This dispute is closed',
        });
      }

      const evidence = await resolveEvidence(input.evidence ?? [], actor.userId);
      const updated = await disputeRepository.addMessage(
        disputeId,
        { authorId: actor.userId, authorRole: 'SELLER', text: input.text.trim() },
        evidence,
      );
      if (!updated) throw new AppError(ErrorCode.DISPUTE_INVALID_TRANSITION, { detail: 'This dispute is closed' });

      if (dispute.status === DisputeStatus.OPEN) {
        await this.escalate(disputeId, 'Seller responded', DisputeStatus.OPEN);
      }
      return (await disputeRepository.findById(disputeId)) ?? updated;
    },

    async addBuyerMessage(
      disputeId: string,
      input: { text: string; evidence?: string[] | undefined },
      actor: Actor,
    ): Promise<DisputeRecord> {
      const dispute = await disputeRepository.findById(disputeId);
      if (!dispute) throw notFound('Dispute');
      if (dispute.buyerId !== actor.userId) throw notFound('Dispute', 'PERM_SCOPE_DENIED');

      const evidence = await resolveEvidence(input.evidence ?? [], actor.userId);
      const updated = await disputeRepository.addMessage(
        disputeId,
        { authorId: actor.userId, authorRole: 'BUYER', text: input.text.trim() },
        evidence,
      );
      if (!updated) throw new AppError(ErrorCode.DISPUTE_INVALID_TRANSITION, { detail: 'This dispute is closed' });
      return updated;
    },

    /** Moves a case to arbitration, whether the seller answered or ignored it. */
    async escalate(disputeId: string, reason: string, expected: DisputeStatus): Promise<void> {
      if (!canTransitionDispute(expected, DisputeStatus.UNDER_REVIEW)) return;
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const moved = await disputeRepository.transition(
            disputeId,
            [expected],
            DisputeStatus.UNDER_REVIEW,
            { sellerRespondedAt: new Date() },
            session,
          );
          if (!moved) return;
          await outboxService.publish(
            {
              type: DisputeEvents.ESCALATED,
              aggregateType: 'dispute',
              aggregateId: disputeId,
              payload: { disputeId, reason },
            },
            session,
          );
        });
      } finally {
        await session.endSession();
      }
    },

    /** The buyer drops their claim; the order returns to where it was. */
    async withdraw(disputeId: string, actor: Actor): Promise<void> {
      const dispute = await disputeRepository.findById(disputeId);
      if (!dispute) throw notFound('Dispute');
      if (dispute.buyerId !== actor.userId) throw notFound('Dispute', 'PERM_SCOPE_DENIED');
      if (dispute.status !== DisputeStatus.OPEN) {
        throw new AppError(ErrorCode.DISPUTE_INVALID_TRANSITION, {
          detail: 'A dispute can only be withdrawn before it reaches a moderator',
        });
      }

      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const moved = await disputeRepository.transition(
            disputeId,
            [DisputeStatus.OPEN],
            DisputeStatus.WITHDRAWN,
            {},
            session,
          );
          if (!moved) {
            throw new AppError(ErrorCode.DISPUTE_INVALID_TRANSITION, {
              detail: 'This dispute changed while your request was being processed',
            });
          }
          // The order was completed before the dispute; withdrawing puts it back there.
          await orders.settle(dispute.orderId, false, actor.userId, 'Dispute withdrawn by buyer', session);
          await outboxService.publish(
            {
              type: DisputeEvents.WITHDRAWN,
              aggregateType: 'dispute',
              aggregateId: disputeId,
              payload: { disputeId, orderId: dispute.orderId, sellerId: dispute.sellerId },
              actorId: actor.userId,
              actorType: ActorType.USER,
            },
            session,
          );
        });
      } finally {
        await session.endSession();
      }

      await audit.record({
        actorId: actor.userId,
        actorType: ActorType.USER,
        action: 'dispute.withdrawn',
        targetType: 'dispute',
        targetId: disputeId,
      });
    },

    /**
     * Arbitrates.
     *
     * Two things happen and both must be atomic with the decision: the order moves to its
     * final state, and the platform gives back the share of commission proportional to what
     * the buyer recovered. Charging full commission on a transaction just judged to have
     * failed would mean profiting from it.
     *
     * The money itself does not move here for a cash order — the platform never held it. The
     * resolution records what the seller owes the buyer directly, which is the honest
     * description of a cash-on-pickup refund.
     */
    async resolve(
      disputeId: string,
      input: { outcome: DisputeOutcome; refundAmount?: string | undefined; reason: string },
      moderatorId: string,
    ): Promise<DisputeRecord> {
      const dispute = await disputeRepository.findById(disputeId);
      if (!dispute) throw notFound('Dispute');
      if (dispute.status !== DisputeStatus.UNDER_REVIEW) {
        throw new AppError(ErrorCode.DISPUTE_INVALID_TRANSITION, {
          detail: 'Only a dispute under review can be resolved',
        });
      }

      const order = await orders.forDispute(dispute.orderId);
      if (!order) throw notFound('Order');
      if (order.paymentMode === 'PREPAID_ONLINE') {
        // No prepaid order can exist until the payments module lands; refusing is the honest
        // answer rather than recording a refund nothing will execute.
        throw new AppError(ErrorCode.DISPUTE_SETTLEMENT_UNSUPPORTED, {
          detail: 'Prepaid orders cannot be settled until online payments are available',
        });
      }

      let refundMinor: bigint;
      try {
        refundMinor = refundAmountFor(
          input.outcome,
          dispute.orderTotal.minor,
          input.refundAmount === undefined ? null : Money.of(input.refundAmount).minor,
        );
      } catch (cause) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, {
          detail: cause instanceof Error ? cause.message : 'Invalid refund amount',
          errors: [{ field: 'refundAmount', code: 'INVALID' }],
        });
      }

      const againstSeller = refundMinor > 0n;
      const commissionReversal = commissionReversalFor(
        order.commissionAmountMinor ?? 0n,
        refundMinor,
        dispute.orderTotal.minor,
      );

      /**
       * Reversed before the transaction: the ledger owns its own atomicity and its entry key
       * makes a repeat harmless, so a retry cannot double-credit the seller.
       *
       * That covers a retry. It does not cover two moderators resolving this dispute at the
       * same moment with different outcomes. Both would pass the UNDER_REVIEW check above; one
       * reverses commission and the other does not; whichever wins the compare-and-set below
       * writes the resolution. If the winner chose no refund, the ledger keeps a reversal
       * attributed to a dispute whose recorded outcome says none was due — money moved for a
       * decision nobody made.
       *
       * The correct order is to claim the dispute first and reverse afterwards, which turns
       * that into the opposite and much better failure: a recorded refund with no ledger entry,
       * which reconciliation surfaces instead of hiding. It is not changed here because the
       * reordering needs two writes to the dispute and a compensating path if the reversal
       * then fails, and none of that can be verified until the integration suites run.
       *
       * Until then the window is narrow — the panel would have to hand the same dispute to two
       * moderators at once — and a claim step on disputes, which seller applications already
       * have, would close it without touching this ordering at all.
       */
      let reversed = Money.zero();
      if (commissionReversal > 0n) {
        reversed = await commission.reverseForOrder(
          dispute.orderId,
          `Dispute ${dispute.disputeNo}: ${input.reason}`,
          moderatorId,
          commissionReversal,
        );
      }

      const session = await mongoose.startSession();
      let resolved: DisputeRecord;
      try {
        resolved = await session.withTransaction(async () => {
          const next = await disputeRepository.transition(
            disputeId,
            [DisputeStatus.UNDER_REVIEW],
            againstSeller ? DisputeStatus.RESOLVED_BUYER : DisputeStatus.RESOLVED_SELLER,
            {
              assignedTo: new mongoose.Types.ObjectId(moderatorId),
              resolution: {
                outcome: input.outcome,
                refundAmountMinor: refundMinor,
                commissionReversedMinor: reversed.minor,
                settlementMethod: SettlementMethod.SELLER_DIRECT,
                reason: input.reason.trim(),
                decidedBy: new mongoose.Types.ObjectId(moderatorId),
                decidedAt: new Date(),
              },
            },
            session,
          );
          if (!next) {
            throw new AppError(ErrorCode.DISPUTE_INVALID_TRANSITION, {
              detail: 'This dispute was resolved by another moderator',
            });
          }

          const settled = await orders.settle(
            dispute.orderId,
            againstSeller,
            moderatorId,
            `Dispute ${dispute.disputeNo} resolved`,
            session,
          );
          if (!settled) {
            throw new AppError(ErrorCode.DISPUTE_INVALID_TRANSITION, {
              detail: 'The order changed while the dispute was being resolved',
            });
          }

          // Reliability follows the decision. A seller regularly disputed and occasionally
          // vindicated is still one buyers should be warned about, so a loss costs more than
          // a win returns.
          const shop = await mongoose.connection
            .collection<{ reliabilityScore: number }>('shops')
            .findOne({ _id: new mongoose.Types.ObjectId(dispute.shopId) }, { session });
          if (shop) {
            await mongoose.connection.collection('shops').updateOne(
              { _id: new mongoose.Types.ObjectId(dispute.shopId) },
              { $set: { reliabilityScore: reliabilityAfter(shop.reliabilityScore, againstSeller) } },
              { session },
            );
          }

          await outboxService.publish(
            {
              type: DisputeEvents.RESOLVED,
              aggregateType: 'dispute',
              aggregateId: disputeId,
              payload: {
                disputeId,
                disputeNo: dispute.disputeNo,
                orderId: dispute.orderId,
                buyerId: dispute.buyerId,
                sellerId: dispute.sellerId,
                shopId: dispute.shopId,
                outcome: input.outcome,
                refundAmount: refundMinor.toString(),
                againstSeller,
              },
              actorId: moderatorId,
              actorType: ActorType.ADMIN,
            },
            session,
          );
          return next;
        });
      } finally {
        await session.endSession();
      }

      await audit.record({
        actorId: moderatorId,
        actorType: ActorType.ADMIN,
        action: againstSeller ? 'dispute.resolved_for_buyer' : 'dispute.resolved_for_seller',
        targetType: 'dispute',
        targetId: disputeId,
        reason: input.reason,
        after: {
          orderNo: dispute.orderNo,
          outcome: input.outcome,
          refund: refundMinor.toString(),
          commissionReversed: reversed.toStorage(),
        },
        severity: AuditSeverity.CRITICAL,
      });
      logger.warn(
        { disputeId, outcome: input.outcome, refund: refundMinor.toString() },
        'dispute resolved',
      );
      return resolved;
    },

    /** Used by the worker when a seller lets their response window lapse. */
    async escalateOverdue(now: Date, limit: number): Promise<number> {
      const overdue = await disputeRepository.findResponseOverdue(limit, now);
      for (const dispute of overdue) {
        await this.escalate(dispute.id, 'Seller did not respond in time', DisputeStatus.OPEN);
      }
      return overdue.length;
    },
  };
}

export type DisputeService = ReturnType<typeof createDisputeService>;
