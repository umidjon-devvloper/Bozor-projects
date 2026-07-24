import mongoose from 'mongoose';
import type { Logger } from '@bozorlar/logger';
import type { DomainEventEnvelope } from '../eventDispatcher.js';

export interface CommissionCharger {
  chargeForOrder(order: {
    id: string;
    orderNo: string;
    sellerId: string;
    shopId: string;
    marketId: string;
    categoryIds: string[];
    totalMinor: bigint;
    createdAt: Date;
    completedAt: Date;
    commissionStatus: string;
  }): Promise<{ charged: boolean }>;
}

interface OrderRow {
  _id: mongoose.Types.ObjectId;
  orderNo: string;
  sellerId: mongoose.Types.ObjectId;
  shopId: mongoose.Types.ObjectId;
  marketId: mongoose.Types.ObjectId;
  totals: { grand: mongoose.mongo.Long };
  lines: Array<{ productId: mongoose.Types.ObjectId }>;
  createdAt: Date;
  commission: { status: string };
}

/**
 * Charges commission when an order completes (COMMISSION_SPEC.md "Timing").
 *
 * This handler is the entire revenue mechanism of the platform, driven by an at-least-once
 * event bus — so idempotency is not a nicety. The charger keys its journal entry on the order
 * id, which makes a redelivery a no-op; this handler adds nothing that could break that.
 *
 * The order is re-read rather than trusted from the payload: an event may be minutes old by
 * the time it is delivered, and billing off a stale total is exactly the sort of quiet error
 * nobody notices until a seller does.
 */
export function createOrderCompletedHandler(charger: CommissionCharger, logger: Logger) {
  return async function handle(event: DomainEventEnvelope): Promise<void> {
    const db = mongoose.connection.db;
    if (!db) throw new Error('No database connection');

    const orderId = String(event.payload.orderId ?? event.aggregateId);
    const order = await db
      .collection<OrderRow>('orders')
      .findOne({ _id: new mongoose.Types.ObjectId(orderId) });

    if (!order) {
      logger.warn({ orderId }, 'order.completed for an order that no longer exists');
      return;
    }
    if (order.commission.status === 'CHARGED') return;

    // Category scope needs the products' categories; one lookup for the whole order.
    const productIds = order.lines.map((line) => line.productId);
    const products = await db
      .collection<{ _id: mongoose.Types.ObjectId; categoryPath: mongoose.Types.ObjectId[] }>('products')
      .find({ _id: { $in: productIds } })
      .project<{ categoryPath: mongoose.Types.ObjectId[] }>({ categoryPath: 1 })
      .toArray();
    const categoryIds = [
      ...new Set(products.flatMap((product) => product.categoryPath.map((id) => id.toString()))),
    ];

    const result = await charger.chargeForOrder({
      id: orderId,
      orderNo: order.orderNo,
      sellerId: order.sellerId.toString(),
      shopId: order.shopId.toString(),
      marketId: order.marketId.toString(),
      categoryIds,
      totalMinor: BigInt(order.totals.grand.toString()),
      // The order's own creation time keys rule resolution, so the answer never depends on
      // when the event happened to be delivered (ADR-0033).
      createdAt: order.createdAt,
      completedAt: event.occurredAt,
      commissionStatus: order.commission.status,
    });

    if (!result.charged) {
      // Already recorded as FAILED with a reason and a CRITICAL audit entry. Throwing here
      // would make the relay retry forever against a missing rule.
      logger.error({ orderId, orderNo: order.orderNo }, 'commission could not be charged');
    }
  };
}
