import mongoose from 'mongoose';
import type { DeliveryService } from '@bozorlar/notifications';
import type { Logger } from '@bozorlar/logger';
import type { DomainEventEnvelope } from '../eventDispatcher.js';
import { text } from '../payload.js';

/**
 * Maps domain events onto notifications.
 *
 * Every event the platform emits has been written to the outbox and relayed to nobody since
 * Phase 0; this is the consumer that turns them into something a person sees. The mapping is
 * explicit and one-way — an event names a template and supplies its variables — so adding a
 * notification never means touching the module that raised the event.
 *
 * `dedupeKey` is the event id, which makes every handler idempotent under the at-least-once
 * delivery the relay provides.
 */

function money(minor: string | undefined): string {
  // Tiyin to a readable som figure, grouped the way a price is written on a stall board.
  const value = BigInt(minor ?? '0') / 100n;
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

interface OrderRow {
  _id: mongoose.Types.ObjectId;
  orderNo: string;
  buyerId: mongoose.Types.ObjectId;
  sellerId: mongoose.Types.ObjectId;
  shopSnapshot: { name: { uz: string }; sectionCode: string | null; stallNo: string | null };
  buyerSnapshot: { name: string };
  totals: { grand: mongoose.mongo.Long };
  cancelReason: string | null;
}

async function loadOrder(orderId: string): Promise<OrderRow | null> {
  const db = mongoose.connection.db;
  if (!db || !mongoose.Types.ObjectId.isValid(orderId)) return null;
  return db.collection<OrderRow>('orders').findOne({ _id: new mongoose.Types.ObjectId(orderId) });
}

function stallLabel(shop: OrderRow['shopSnapshot']): string {
  const parts = [shop.sectionCode, shop.stallNo].filter(Boolean);
  // A bazaar is a maze; "row B, stall 42" is the difference between finding the stall and not.
  return parts.length > 0 ? parts.join('-') : shop.name.uz;
}

export function registerNotificationHandlers(
  on: (type: string, handler: (event: DomainEventEnvelope) => Promise<void>) => void,
  delivery: DeliveryService,
  logger: Logger,
): void {
  /** The seller has a new order and a clock running. */
  on('order.created', async (event) => {
    const order = await loadOrder(text(event.payload.orderId, event.aggregateId));
    if (!order) return;
    await delivery.send({
      dedupeKey: `${event.eventId}:seller`,
      userId: order.sellerId.toString(),
      type: 'order.created',
      targetId: order._id.toString(),
      variables: {
        buyerName: order.buyerSnapshot.name,
        total: money(order.totals.grand.toString()),
        minutes: '30',
      },
    });
  });

  on('order.accepted', async (event) => {
    const order = await loadOrder(text(event.payload.orderId, event.aggregateId));
    if (!order) return;
    await delivery.send({
      dedupeKey: `${event.eventId}:buyer`,
      userId: order.buyerId.toString(),
      type: 'order.accepted',
      targetId: order._id.toString(),
      variables: { shopName: order.shopSnapshot.name.uz },
    });
  });

  on('order.rejected', async (event) => {
    const order = await loadOrder(text(event.payload.orderId, event.aggregateId));
    if (!order) return;
    await delivery.send({
      dedupeKey: `${event.eventId}:buyer`,
      userId: order.buyerId.toString(),
      type: 'order.rejected',
      targetId: order._id.toString(),
      variables: {
        shopName: order.shopSnapshot.name.uz,
        reason: order.cancelReason ?? '—',
      },
    });
  });

  /** The one message a buyer is actually waiting for, so it goes by SMS as well as push. */
  on('order.ready_for_pickup', async (event) => {
    const order = await loadOrder(text(event.payload.orderId, event.aggregateId));
    if (!order) return;
    await delivery.send({
      dedupeKey: `${event.eventId}:buyer`,
      userId: order.buyerId.toString(),
      type: 'order.ready_for_pickup',
      targetId: order._id.toString(),
      variables: { shopName: order.shopSnapshot.name.uz, stall: stallLabel(order.shopSnapshot) },
    });
  });

  on('order.adjustment_requested', async (event) => {
    const order = await loadOrder(text(event.payload.orderId, event.aggregateId));
    if (!order) return;
    await delivery.send({
      dedupeKey: `${event.eventId}:buyer`,
      userId: order.buyerId.toString(),
      type: 'order.adjustment_requested',
      targetId: order._id.toString(),
      variables: {
        newTotal: money(text(event.payload.newTotal, '0')),
        oldTotal: money(text(event.payload.oldTotal, '0')),
        minutes: '30',
      },
    });
  });

  on('order.completed', async (event) => {
    const order = await loadOrder(text(event.payload.orderId, event.aggregateId));
    if (!order) return;
    await delivery.send({
      dedupeKey: `${event.eventId}:buyer`,
      userId: order.buyerId.toString(),
      type: 'order.completed',
      targetId: order._id.toString(),
      variables: { shopName: order.shopSnapshot.name.uz },
    });
  });

  /** Both sides are told, because either may have been the one who did not cancel. */
  on('order.cancelled', async (event) => {
    const order = await loadOrder(text(event.payload.orderId, event.aggregateId));
    if (!order) return;
    for (const [suffix, userId] of [
      ['buyer', order.buyerId.toString()],
      ['seller', order.sellerId.toString()],
    ] as const) {
      await delivery.send({
        dedupeKey: `${event.eventId}:${suffix}`,
        userId,
        type: 'order.cancelled',
        targetId: order._id.toString(),
        variables: { orderNo: order.orderNo },
      });
    }
  });

  on('order.expired', async (event) => {
    const order = await loadOrder(text(event.payload.orderId, event.aggregateId));
    if (!order) return;
    await delivery.send({
      dedupeKey: `${event.eventId}:buyer`,
      userId: order.buyerId.toString(),
      type: 'order.expired',
      targetId: order._id.toString(),
      variables: { orderNo: order.orderNo },
    });
  });

  on('wallet.low_balance', async (event) => {
    const sellerId = text(event.payload.sellerId);
    if (!sellerId) return;
    await delivery.send({
      dedupeKey: event.eventId,
      userId: sellerId,
      type: 'wallet.low_balance',
      targetId: text(event.payload.walletId),
      variables: { balance: money(text(event.payload.balance, '0')) },
    });
  });

  /** The seller has just vanished from the catalogue; they need to know why, immediately. */
  on('seller.deactivated', async (event) => {
    const sellerId = text(event.payload.sellerId);
    if (!sellerId) return;
    await delivery.send({
      dedupeKey: event.eventId,
      userId: sellerId,
      type: 'seller.deactivated',
      targetId: text(event.payload.walletId),
      variables: {},
    });
  });

  on('seller.approved', async (event) => {
    const userId = text(event.payload.userId);
    if (!userId) return;
    await delivery.send({
      dedupeKey: event.eventId,
      userId,
      type: 'seller.approved',
      targetId: text(event.payload.applicationId),
      variables: {},
    });
  });

  on('seller.rejected', async (event) => {
    const db = mongoose.connection.db;
    const userId = text(event.payload.userId);
    if (!db || !userId) return;
    const application = await db
      .collection<{ rejectionReason: string | null }>('seller_applications')
      .findOne({ _id: new mongoose.Types.ObjectId(text(event.payload.applicationId)) });
    await delivery.send({
      dedupeKey: event.eventId,
      userId,
      type: 'seller.rejected',
      targetId: text(event.payload.applicationId),
      variables: { reason: application?.rejectionReason ?? '—' },
    });
  });

  on('shop.moderation_decided', async (event) => {
    const db = mongoose.connection.db;
    if (!db || event.payload.approved !== true) return;
    const shop = await db
      .collection<{ ownerId: mongoose.Types.ObjectId; name: { uz: string } }>('shops')
      .findOne({ _id: new mongoose.Types.ObjectId(event.aggregateId) });
    if (!shop) return;
    await delivery.send({
      dedupeKey: event.eventId,
      userId: shop.ownerId.toString(),
      type: 'shop.moderation_approved',
      targetId: event.aggregateId,
      variables: { shopName: shop.name.uz },
    });
  });

  on('product.moderation_decided', async (event) => {
    const db = mongoose.connection.db;
    if (!db || event.payload.approved === true) return;
    const product = await db
      .collection<{ shopId: mongoose.Types.ObjectId; name: { uz: string } }>('products')
      .findOne({ _id: new mongoose.Types.ObjectId(event.aggregateId) });
    if (!product) return;
    const shop = await db
      .collection<{ ownerId: mongoose.Types.ObjectId }>('shops')
      .findOne({ _id: product.shopId });
    if (!shop) return;
    await delivery.send({
      dedupeKey: event.eventId,
      userId: shop.ownerId.toString(),
      type: 'product.moderation_rejected',
      targetId: event.aggregateId,
      variables: { productName: product.name.uz, reason: text(event.payload.reason, '—') },
    });
  });

  /** A review is the seller's feedback loop; they should not have to go looking for it. */
  on('review.created', async (event) => {
    const db = mongoose.connection.db;
    if (!db) return;
    const shop = await db
      .collection<{ ownerId: mongoose.Types.ObjectId }>('shops')
      .findOne({ _id: new mongoose.Types.ObjectId(text(event.payload.shopId)) });
    if (!shop) return;
    await delivery.send({
      dedupeKey: `${event.eventId}:seller`,
      userId: shop.ownerId.toString(),
      type: 'review.created',
      targetId: event.aggregateId,
      variables: {
        buyerName: text(event.payload.buyerName),
        rating: text(event.payload.rating),
      },
    });
  });

  on('review.replied', async (event) => {
    const db = mongoose.connection.db;
    if (!db) return;
    const buyerId = text(event.payload.buyerId);
    const shop = await db
      .collection<{ name: { uz: string } }>('shops')
      .findOne({ _id: new mongoose.Types.ObjectId(text(event.payload.shopId)) });
    if (!buyerId || !shop) return;
    await delivery.send({
      dedupeKey: `${event.eventId}:buyer`,
      userId: buyerId,
      type: 'review.replied',
      targetId: event.aggregateId,
      variables: { shopName: shop.name.uz },
    });
  });

  /** The seller has a clock running and may not be watching the app. */
  on('dispute.raised', async (event) => {
    const sellerId = text(event.payload.sellerId);
    if (!sellerId) return;
    await delivery.send({
      dedupeKey: `${event.eventId}:seller`,
      userId: sellerId,
      type: 'dispute.raised',
      targetId: event.aggregateId,
      variables: { orderNo: text(event.payload.orderNo), hours: '48' },
    });
  });

  /** Both parties hear the decision, because it binds both of them. */
  on('dispute.resolved', async (event) => {
    const outcome = text(event.payload.outcome);
    for (const [suffix, key] of [
      ['buyer', 'buyerId'],
      ['seller', 'sellerId'],
    ] as const) {
      const userId = text(event.payload[key]);
      if (!userId) continue;
      await delivery.send({
        dedupeKey: `${event.eventId}:${suffix}`,
        userId,
        type: 'dispute.resolved',
        targetId: event.aggregateId,
        variables: { orderNo: text(event.payload.disputeNo), outcome },
      });
    }
  });

  logger.info({}, 'notification handlers registered');
}
