import { Types } from 'mongoose';
import { orderRepository } from '../repositories/order.repository.js';
import type { OrderStatus } from '@bozorlar/domain';

/**
 * What the reviews module needs to know about an order.
 *
 * A purpose-built projection rather than the order repository: reviews only ever ask "did this
 * person buy this thing, and is it settled?", and a wider surface would invite it to grow
 * opinions about order state that belong here (ADR-0011 rule 1).
 */
export const orderReviewLookup = {
  async forReview(orderId: string): Promise<{
    id: string;
    orderNo: string;
    buyerId: string;
    shopId: string;
    status: OrderStatus;
    completedAt: Date | null;
    productIds: string[];
    buyerName: string;
  } | null> {
    if (!Types.ObjectId.isValid(orderId)) return null;
    const doc = await orderRepository.findForReview(orderId);
    if (!doc) return null;

    // Completion time comes from the status history rather than a dedicated field, so the
    // review window is measured from the moment the order actually settled.
    const completion = [...doc.statusHistory]
      .reverse()
      .find((change) => change.to === 'COMPLETED');

    return {
      id: doc._id.toString(),
      orderNo: doc.orderNo,
      buyerId: doc.buyerId.toString(),
      shopId: doc.shopId.toString(),
      status: doc.status,
      completedAt: completion?.at ?? null,
      productIds: doc.lines.map((line) => line.productId.toString()),
      buyerName: doc.buyerSnapshot.name,
    };
  },
};
