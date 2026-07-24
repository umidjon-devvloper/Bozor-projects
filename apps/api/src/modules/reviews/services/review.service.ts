import mongoose from 'mongoose';
import { AppError, ErrorCode, notFound } from '@bozorlar/errors';
import type { Logger } from '@bozorlar/logger';
import { isValidRating, OrderStatus } from '@bozorlar/domain';
import { ActorType, AuditSeverity } from '@bozorlar/types';
import { outboxService } from '../../outbox/index.js';
import type { AuditService } from '../../audit/index.js';
import { MediaPurpose, type MediaService } from '../../media/index.js';
import { parseQuery, toPage, type Page, type QuerySpec } from '../../../http/query.js';
import { reviewRepository, type ReviewRecord } from '../repositories/review.repository.js';
import { ratingAggregation } from './ratingAggregation.service.js';
import {
  AUTO_REPORT_THRESHOLD,
  COUNTED_STATUSES,
  MAX_REVIEW_PHOTOS,
  REVIEW_WINDOW_DAYS,
  ReportReason,
  ReviewStatus,
} from '../reviews.constants.js';
import { ReviewEvents } from '../events.js';

export const REVIEW_QUERY_SPEC: QuerySpec = {
  filters: [
    { field: 'productId', type: 'objectId', operators: ['eq'] },
    { field: 'shopId', type: 'objectId', operators: ['eq'] },
    { field: 'rating', type: 'number', operators: ['eq', 'gte', 'lte'] },
    { field: 'status', type: 'string', operators: ['eq', 'in'] },
  ],
  sorts: [
    { key: '-createdAt', sort: { createdAt: -1, _id: -1 } },
    { key: '-rating', sort: { rating: -1, _id: -1 } },
    { key: 'rating', sort: { rating: 1, _id: 1 } },
  ],
  defaultSort: '-createdAt',
};

/** What the reviews module needs to know about an order. Supplied by the orders module. */
export interface ReviewableOrder {
  id: string;
  orderNo: string;
  buyerId: string;
  shopId: string;
  status: OrderStatus;
  completedAt: Date | null;
  productIds: string[];
  buyerName: string;
}

export interface OrderLookup {
  forReview(orderId: string): Promise<ReviewableOrder | null>;
}

export interface Actor {
  userId: string;
  shopIds: readonly string[];
}

export function createReviewService(deps: {
  orders: OrderLookup;
  media: MediaService;
  audit: AuditService;
  logger: Logger;
}) {
  const { orders, media, audit, logger } = deps;

  return {
    /**
     * Leaves a review.
     *
     * Eligibility is checked against the order, not asserted by the client: a review anybody
     * can leave is a review nobody trusts, and the completed order is the proof of purchase
     * (REVIEW_SYSTEM.md).
     */
    async create(input: {
      orderId: string;
      productId: string;
      rating: number;
      comment?: string | undefined;
      photos?: string[] | undefined;
      actor: Actor;
    }): Promise<ReviewRecord> {
      if (!isValidRating(input.rating)) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, {
          detail: 'A rating is a whole number of stars from 1 to 5',
          errors: [{ field: 'rating', code: 'OUT_OF_RANGE' }],
        });
      }

      const order = await orders.forReview(input.orderId);
      if (!order) throw notFound('Order');
      if (order.buyerId !== input.actor.userId) {
        throw notFound('Order', `PERM_SCOPE_DENIED user=${input.actor.userId}`);
      }
      if (order.status !== OrderStatus.COMPLETED) {
        throw new AppError(ErrorCode.REVIEW_NOT_ELIGIBLE, {
          detail: 'You can review an order once it has been completed',
        });
      }
      if (!order.productIds.includes(input.productId)) {
        throw new AppError(ErrorCode.REVIEW_NOT_ELIGIBLE, {
          detail: 'That product was not part of this order',
        });
      }

      const completedAt = order.completedAt ?? new Date(0);
      const deadline = completedAt.getTime() + REVIEW_WINDOW_DAYS * 24 * 60 * 60 * 1000;
      if (Date.now() > deadline) {
        // Late enough that the seller cannot reasonably remember the purchase.
        throw new AppError(ErrorCode.REVIEW_WINDOW_CLOSED, {
          detail: `Reviews close ${REVIEW_WINDOW_DAYS} days after an order is completed`,
        });
      }
      if (await reviewRepository.existsForOrderLine(input.orderId, input.productId)) {
        throw new AppError(ErrorCode.REVIEW_ALREADY_EXISTS, {
          detail: 'You have already reviewed this item from this order',
        });
      }

      const photoKeys = input.photos ?? [];
      if (photoKeys.length > MAX_REVIEW_PHOTOS) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, {
          detail: `At most ${MAX_REVIEW_PHOTOS} photos`,
        });
      }
      const resolved = await media.resolveMany(photoKeys);
      const photos = photoKeys.map((mediaKey) => {
        const asset = resolved.get(mediaKey);
        if (!asset) {
          throw new AppError(ErrorCode.MEDIA_UPLOAD_NOT_CONFIRMED, {
            detail: `Photo ${mediaKey} has not been confirmed`,
          });
        }
        return { mediaKey, blurhash: asset.blurhash };
      });

      const session = await mongoose.startSession();
      let review: ReviewRecord;
      try {
        review = await session.withTransaction(async () => {
          const created = await reviewRepository.create(
            {
              orderId: order.id,
              orderNo: order.orderNo,
              productId: input.productId,
              shopId: order.shopId,
              buyerId: input.actor.userId,
              buyerName: order.buyerName,
              rating: input.rating,
              comment: input.comment?.trim() || null,
              photos,
            },
            session,
          );

          // The aggregate moves in the same transaction as the review, so the list and the
          // score can never disagree — not even for the moment between two writes.
          await ratingAggregation.apply(
            { productId: input.productId, shopId: order.shopId, ratingDelta: input.rating, countDelta: 1 },
            session,
          );

          if (photoKeys.length > 0) {
            await media.attachToEntity({
              mediaKeys: photoKeys,
              target: { type: 'review', id: created.id },
              expectedPurpose: MediaPurpose.REVIEW_PHOTO,
              ownerId: input.actor.userId,
              session,
            });
          }

          await outboxService.publish(
            {
              type: ReviewEvents.CREATED,
              aggregateType: 'review',
              aggregateId: created.id,
              payload: {
                reviewId: created.id,
                productId: input.productId,
                shopId: order.shopId,
                rating: input.rating,
                buyerName: order.buyerName,
              },
              actorId: input.actor.userId,
              actorType: ActorType.USER,
            },
            session,
          );
          // Search ranks on the Bayesian score, so the index has to be told it moved.
          await outboxService.publish(
            {
              type: ReviewEvents.RATING_CHANGED,
              aggregateType: 'product',
              aggregateId: input.productId,
              payload: { productId: input.productId, shopId: order.shopId },
            },
            session,
          );
          return created;
        });
      } finally {
        await session.endSession();
      }

      logger.info({ reviewId: review.id, productId: input.productId, rating: input.rating }, 'review created');
      return review;
    },

    async listForProduct(productId: string, query: Record<string, unknown>): Promise<Page<ReviewRecord>> {
      const parsed = parseQuery(query, REVIEW_QUERY_SPEC);
      const rows = await reviewRepository.list(parsed, {
        productId: new mongoose.Types.ObjectId(productId),
        status: { $in: COUNTED_STATUSES },
      });
      const page = toPage(rows as unknown as Record<string, unknown>[], parsed);
      return {
        items: page.items as unknown as ReviewRecord[],
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      };
    },

    async listForShop(shopId: string, query: Record<string, unknown>): Promise<Page<ReviewRecord>> {
      const parsed = parseQuery(query, REVIEW_QUERY_SPEC);
      const rows = await reviewRepository.list(parsed, {
        shopId: new mongoose.Types.ObjectId(shopId),
        status: { $in: COUNTED_STATUSES },
      });
      const page = toPage(rows as unknown as Record<string, unknown>[], parsed);
      return {
        items: page.items as unknown as ReviewRecord[],
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      };
    },

    async summary(target: { type: 'product' | 'shop'; id: string }) {
      const distribution = await reviewRepository.distribution({
        field: target.type === 'product' ? 'productId' : 'shopId',
        id: target.id,
      });
      const count = Object.values(distribution).reduce((sum, value) => sum + value, 0);
      const total = Object.entries(distribution).reduce(
        (sum, [stars, n]) => sum + Number(stars) * n,
        0,
      );
      return { distribution, count, average: count > 0 ? total / count : 0 };
    },

    /** A seller answers once. A thread of replies is a conversation, not a review. */
    async reply(reviewId: string, text: string, actor: Actor): Promise<ReviewRecord> {
      const review = await reviewRepository.findById(reviewId);
      if (!review) throw notFound('Review');
      if (!actor.shopIds.includes(review.shopId)) {
        throw notFound('Review', `PERM_SCOPE_DENIED user=${actor.userId}`);
      }

      const updated = await reviewRepository.addSellerReply(reviewId, {
        text: text.trim(),
        by: actor.userId,
      });
      if (!updated) {
        throw new AppError(ErrorCode.REVIEW_ALREADY_REPLIED, {
          detail: 'You have already answered this review',
        });
      }

      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          await outboxService.publish(
            {
              type: ReviewEvents.REPLIED,
              aggregateType: 'review',
              aggregateId: reviewId,
              payload: { reviewId, shopId: review.shopId, buyerId: review.buyerId },
              actorId: actor.userId,
              actorType: ActorType.USER,
            },
            session,
          );
        });
      } finally {
        await session.endSession();
      }
      return updated;
    },

    /**
     * Flags a review for moderation.
     *
     * The review keeps counting toward the rating while it is under review. Removing a score
     * on an accusation alone would make reporting a way to attack a competitor's rating,
     * which is a worse failure than a bad review staying up for a day (MODERATION.md).
     */
    async report(
      reviewId: string,
      input: { reason: ReportReason; note?: string | undefined },
      actor: Actor,
    ): Promise<{ reported: boolean; queued: boolean }> {
      const result = await reviewRepository.addReport(reviewId, {
        userId: actor.userId,
        reason: input.reason,
        note: input.note ?? null,
      });
      if (!result) throw notFound('Review');
      if (!result.added) return { reported: true, queued: false };

      const queued = result.record.reportCount >= AUTO_REPORT_THRESHOLD;
      if (queued && result.record.status === ReviewStatus.PUBLISHED) {
        const session = await mongoose.startSession();
        try {
          await session.withTransaction(async () => {
            await reviewRepository.setStatus(
              reviewId,
              [ReviewStatus.PUBLISHED],
              ReviewStatus.REPORTED,
              {},
              session,
            );
            await outboxService.publish(
              {
                type: ReviewEvents.REPORTED,
                aggregateType: 'review',
                aggregateId: reviewId,
                payload: { reviewId, reports: result.record.reportCount },
              },
              session,
            );
          });
        } finally {
          await session.endSession();
        }
      }

      await audit.record({
        actorId: actor.userId,
        actorType: ActorType.USER,
        action: 'review.reported',
        targetType: 'review',
        targetId: reviewId,
        after: { reason: input.reason, totalReports: result.record.reportCount, queued },
      });
      return { reported: true, queued };
    },

    /** The author withdraws their own review; the score follows it. */
    async withdraw(reviewId: string, actor: Actor): Promise<void> {
      const review = await reviewRepository.findById(reviewId);
      if (!review) throw notFound('Review');
      if (review.buyerId !== actor.userId) throw notFound('Review', 'PERM_SCOPE_DENIED');
      if (!COUNTED_STATUSES.includes(review.status)) {
        throw new AppError(ErrorCode.RESOURCE_CONFLICT, { detail: 'This review is no longer active' });
      }
      await this.retract(review, ReviewStatus.WITHDRAWN, null, actor.userId, 'USER');
    },

    async moderate(
      reviewId: string,
      decision: { hide: boolean; reason: string },
      moderatorId: string,
    ): Promise<ReviewRecord> {
      const review = await reviewRepository.findById(reviewId);
      if (!review) throw notFound('Review');

      if (decision.hide) {
        await this.retract(review, ReviewStatus.HIDDEN, decision.reason, moderatorId, 'ADMIN');
        const hidden = await reviewRepository.findById(reviewId);
        if (!hidden) throw notFound('Review');
        return hidden;
      }

      // Cleared: the review returns to the catalogue with its reports on record.
      const session = await mongoose.startSession();
      let restored: ReviewRecord;
      try {
        restored = await session.withTransaction(async () => {
          const next = await reviewRepository.setStatus(
            reviewId,
            [ReviewStatus.REPORTED, ReviewStatus.HIDDEN],
            ReviewStatus.PUBLISHED,
            { moderatedBy: new mongoose.Types.ObjectId(moderatorId), moderatedAt: new Date(), moderationReason: decision.reason },
            session,
          );
          if (!next) throw new AppError(ErrorCode.RESOURCE_CONFLICT, { detail: 'Review already resolved' });

          // Restoring a hidden review puts its score back.
          if (review.status === ReviewStatus.HIDDEN) {
            await ratingAggregation.apply(
              { productId: review.productId, shopId: review.shopId, ratingDelta: review.rating, countDelta: 1 },
              session,
            );
            await outboxService.publish(
              {
                type: ReviewEvents.RATING_CHANGED,
                aggregateType: 'product',
                aggregateId: review.productId,
                payload: { productId: review.productId, shopId: review.shopId },
              },
              session,
            );
          }
          await outboxService.publish(
            {
              type: ReviewEvents.MODERATED,
              aggregateType: 'review',
              aggregateId: reviewId,
              payload: { reviewId, hidden: false },
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
        action: 'review.cleared',
        targetType: 'review',
        targetId: reviewId,
        reason: decision.reason,
        severity: AuditSeverity.WARNING,
      });
      return restored;
    },

    /** Removes a review's contribution to the score and moves it to a non-counted status. */
    async retract(
      review: ReviewRecord,
      status: ReviewStatus,
      reason: string | null,
      actorId: string,
      actorType: 'USER' | 'ADMIN',
    ): Promise<void> {
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const next = await reviewRepository.setStatus(
            review.id,
            [...COUNTED_STATUSES],
            status,
            {
              ...(reason !== null
                ? {
                    moderationReason: reason,
                    moderatedBy: new mongoose.Types.ObjectId(actorId),
                    moderatedAt: new Date(),
                  }
                : {}),
            },
            session,
          );
          if (!next) {
            throw new AppError(ErrorCode.RESOURCE_CONFLICT, {
              detail: 'This review changed while your request was being processed',
            });
          }

          await ratingAggregation.apply(
            {
              productId: review.productId,
              shopId: review.shopId,
              ratingDelta: -review.rating,
              countDelta: -1,
            },
            session,
          );
          await outboxService.publish(
            {
              type: status === ReviewStatus.HIDDEN ? ReviewEvents.MODERATED : ReviewEvents.WITHDRAWN,
              aggregateType: 'review',
              aggregateId: review.id,
              payload: { reviewId: review.id, hidden: status === ReviewStatus.HIDDEN },
              actorId,
              actorType: actorType === 'ADMIN' ? ActorType.ADMIN : ActorType.USER,
            },
            session,
          );
          await outboxService.publish(
            {
              type: ReviewEvents.RATING_CHANGED,
              aggregateType: 'product',
              aggregateId: review.productId,
              payload: { productId: review.productId, shopId: review.shopId },
            },
            session,
          );
        });
      } finally {
        await session.endSession();
      }

      await audit.record({
        actorId,
        actorType: actorType === 'ADMIN' ? ActorType.ADMIN : ActorType.USER,
        action: status === ReviewStatus.HIDDEN ? 'review.hidden' : 'review.withdrawn',
        targetType: 'review',
        targetId: review.id,
        reason,
        severity: status === ReviewStatus.HIDDEN ? AuditSeverity.WARNING : AuditSeverity.INFO,
      });
    },

    /** Proves the incremental aggregate against the reviews themselves. */
    async reconcile(target: { type: 'product' | 'shop'; id: string }) {
      const computed = await ratingAggregation.recompute(target);
      return computed;
    },

    async repair(target: { type: 'product' | 'shop'; id: string }, moderatorId: string) {
      const computed = await ratingAggregation.recompute(target);
      await ratingAggregation.reset(target, computed);
      await audit.record({
        actorId: moderatorId,
        actorType: ActorType.ADMIN,
        action: 'review.aggregate_repaired',
        targetType: target.type,
        targetId: target.id,
        after: { count: computed.count, sumScaled: computed.sumScaled },
        severity: AuditSeverity.CRITICAL,
      });
      return computed;
    },
  };
}

export type ReviewService = ReturnType<typeof createReviewService>;
