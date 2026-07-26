import mongoose from 'mongoose';
import type { Redis } from 'ioredis';
import type { Logger } from '@bozorlar/logger';
import { acquireLock } from './lock.js';

const INTERVAL_MS = 60_000;
const LOCK_TTL_MS = 55_000;
const BATCH_SIZE = 200;

/**
 * The driver's `PushOperator` rejects `$each`/`$slice` against an untyped `Document`, so the
 * collection is typed with the array present. The shape is enforced by the Mongoose model
 * and the collection validator; this only satisfies the driver's generics.
 */
interface OrderRow {
  _id: mongoose.Types.ObjectId;
  statusHistory: unknown[];
  orderNo: string;
  groupId: mongoose.Types.ObjectId;
  shopId: mongoose.Types.ObjectId;
  buyerId: mongoose.Types.ObjectId;
  sellerId: mongoose.Types.ObjectId;
  status: string;
  totals: { grand: mongoose.mongo.Long };
}

interface ReservationRow {
  _id: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  qtyMilli: mongoose.mongo.Long;
}

/**
 * The order clocks (ORDER_SYSTEM.md "Timers").
 *
 * Three deadlines that nobody presses a button for: a seller who never answers, a buyer who
 * collects and never confirms, and an adjustment left hanging. Each one is a state the order
 * would sit in forever otherwise — the first silently holding stock, the second silently
 * withholding the seller's commission.
 *
 * Every transition writes its outbox event in the same transaction as the state change, so a
 * crash mid-sweep cannot expire an order without telling anyone.
 */
export function createOrderTimersSweeper(redis: Redis, logger: Logger) {
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  async function releaseStockFor(
    orderId: mongoose.Types.ObjectId,
    session: mongoose.ClientSession,
  ): Promise<void> {
    const db = mongoose.connection.db;
    if (!db) return;
    const held = await db
      .collection<ReservationRow>('stock_reservations')
      .find({ holderId: orderId.toString(), status: 'ACTIVE' })
      .toArray();
    /**
     * Claim each reservation before releasing its stock — see the same reasoning in
     * `reservationSweeper`. The reservation sweeper releases these very rows on its own clock,
     * so both paths could decrement the same hold while only one changed its status, and the
     * product would end up looking like it had stock nobody is holding.
     */
    const releasedAt = new Date();
    for (const reservation of held) {
      const claimed = await db.collection('stock_reservations').updateOne(
        { _id: reservation._id, status: 'ACTIVE' },
        { $set: { status: 'RELEASED', releasedAt } },
        { session },
      );
      if (claimed.modifiedCount !== 1) continue;

      await db
        .collection('products')
        .updateOne(
          { _id: reservation.productId },
          { $inc: { reservedQtyMilli: reservation.qtyMilli.negate() } },
          { session },
        );
    }
  }

  async function publish(
    session: mongoose.ClientSession,
    type: string,
    order: OrderRow,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const db = mongoose.connection.db;
    if (!db) return;
    await db.collection('outbox').insertOne(
      {
        eventId: crypto.randomUUID(),
        type,
        version: 1,
        aggregateType: 'order',
        aggregateId: order._id.toString(),
        payload: {
          orderId: order._id.toString(),
          orderNo: order.orderNo,
          shopId: order.shopId.toString(),
          buyerId: order.buyerId.toString(),
          ...payload,
        },
        traceId: null,
        actorId: null,
        actorType: 'SYSTEM',
        occurredAt: new Date(),
        publishedAt: null,
        attempts: 0,
        lastError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      { session },
    );
  }

  /** Sellers who never answered. Stock goes back on sale. */
  async function expireUnaccepted(now: Date): Promise<number> {
    const db = mongoose.connection.db;
    if (!db) return 0;
    const due = await db
      .collection<OrderRow>('orders')
      .find({ status: 'PENDING', acceptDeadline: { $lte: now } })
      .limit(BATCH_SIZE)
      .toArray();
    if (due.length === 0) return 0;

    let moved = 0;
    let failed = 0;
    for (const order of due) {
      // One bad row must not end the batch, and must not end the three sweeps that run
      // after this one — a deterministic failure here would otherwise block commission
      // charging and dispute escalation for as long as the row survives.
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const updated = await db.collection<OrderRow>('orders').updateOne(
            { _id: order._id, status: 'PENDING' },
            {
              $set: {
                status: 'EXPIRED',
                cancelledBy: 'SYSTEM',
                cancelReasonCode: 'ACCEPT_WINDOW_EXPIRED',
                cancelReason: 'The seller did not respond within the accept window',
              },
              $push: {
                statusHistory: {
                  $each: [
                    {
                      from: 'PENDING',
                      to: 'EXPIRED',
                      at: now,
                      by: null,
                      actor: 'SYSTEM',
                      reasonCode: 'ACCEPT_WINDOW_EXPIRED',
                      reason: null,
                    },
                  ],
                  $slice: -50,
                },
              },
            },
            { session },
          );
          // Somebody accepted it in the same instant; their write wins and this one stands down.
          if (updated.modifiedCount !== 1) return;

          await releaseStockFor(order._id, session);
          await publish(session, 'order.expired', order, { reason: 'ACCEPT_WINDOW_EXPIRED' });
          moved += 1;
        });
      } catch (error) {
        failed += 1;
        logger.error({ err: error, orderId: order._id.toString() }, 'sweep step failed: expiring an unaccepted order');
      } finally {
        await session.endSession();
      }
    }
    logger.info({ count: moved, failed }, 'unaccepted orders expired');
    return moved;
  }

  /**
   * Collected but never confirmed.
   *
   * Without this the seller's commission is never charged and the order never closes, because
   * a buyer walking away from a stall with their shopping has no reason to open the app again.
   */
  async function autoComplete(now: Date): Promise<number> {
    const db = mongoose.connection.db;
    if (!db) return 0;
    const due = await db
      .collection<OrderRow>('orders')
      .find({ status: 'PICKED_UP', autoCompleteAt: { $lte: now } })
      .limit(BATCH_SIZE)
      .toArray();
    if (due.length === 0) return 0;

    let moved = 0;
    let failed = 0;
    for (const order of due) {
      // One bad row must not end the batch, and must not end the three sweeps that run
      // after this one — a deterministic failure here would otherwise block commission
      // charging and dispute escalation for as long as the row survives.
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const updated = await db.collection<OrderRow>('orders').updateOne(
            { _id: order._id, status: 'PICKED_UP' },
            {
              $set: {
                status: 'COMPLETED',
                disputeDeadline: new Date(now.getTime() + 72 * 60 * 60 * 1000),
              },
              $push: {
                statusHistory: {
                  $each: [
                    { from: 'PICKED_UP', to: 'COMPLETED', at: now, by: null, actor: 'SYSTEM', reasonCode: null, reason: null },
                  ],
                  $slice: -50,
                },
              },
            },
            { session },
          );
          if (updated.modifiedCount !== 1) return;

          // The wallet module charges commission off this event (COMMISSION_SPEC.md).
          await publish(session, 'order.completed', order, {
            sellerId: order.sellerId.toString(),
            total: order.totals.grand.toString(),
            completedAt: now.toISOString(),
            autoCompleted: true,
          });
          moved += 1;
        });
      } catch (error) {
        failed += 1;
        logger.error({ err: error, orderId: order._id.toString() }, 'sweep step failed: auto-completing an order');
      } finally {
        await session.endSession();
      }
    }
    logger.info({ count: moved, failed }, 'orders auto-completed');
    return moved;
  }

  /** Adjustments the buyer never answered. Cancelled with no penalty to either side. */
  async function expireAdjustments(now: Date): Promise<number> {
    const db = mongoose.connection.db;
    if (!db) return 0;
    const due = await db
      .collection<{ _id: mongoose.Types.ObjectId; orderId: mongoose.Types.ObjectId }>('order_adjustments')
      .find({ status: 'PENDING', expiresAt: { $lte: now } })
      .limit(BATCH_SIZE)
      .toArray();
    if (due.length === 0) return 0;

    let moved = 0;
    let failed = 0;
    for (const adjustment of due) {
      // One bad row must not end the batch, and must not end the three sweeps that run
      // after this one — a deterministic failure here would otherwise block commission
      // charging and dispute escalation for as long as the row survives.
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const resolved = await db
            .collection('order_adjustments')
            .updateOne(
              { _id: adjustment._id, status: 'PENDING' },
              { $set: { status: 'EXPIRED', respondedAt: now } },
              { session },
            );
          if (resolved.modifiedCount !== 1) return;

          const order = await db
            .collection<OrderRow>('orders')
            .findOne({ _id: adjustment.orderId }, { session });
          if (!order || order.status !== 'PENDING_ADJUSTMENT') return;

          await db.collection<OrderRow>('orders').updateOne(
            { _id: order._id, status: 'PENDING_ADJUSTMENT' },
            {
              $set: {
                status: 'CANCELLED',
                cancelledBy: 'SYSTEM',
                cancelReasonCode: 'ADJUSTMENT_TIMEOUT',
                cancelReason: 'The buyer did not respond to the weight adjustment',
                cancelPenalised: false,
              },
              $push: {
                statusHistory: {
                  $each: [
                    { from: 'PENDING_ADJUSTMENT', to: 'CANCELLED', at: now, by: null, actor: 'SYSTEM', reasonCode: 'ADJUSTMENT_TIMEOUT', reason: null },
                  ],
                  $slice: -50,
                },
              },
            },
            { session },
          );
          await releaseStockFor(order._id, session);
          await publish(session, 'order.cancelled', order, { reason: 'ADJUSTMENT_TIMEOUT' });
          moved += 1;
        });
      } catch (error) {
        failed += 1;
        logger.error({ err: error, adjustmentId: adjustment._id.toString() }, 'sweep step failed: cancelling a stale adjustment');
      } finally {
        await session.endSession();
      }
    }
    logger.info({ count: moved, failed }, 'stale adjustments cancelled');
    return moved;
  }

  /**
   * Moves a dispute to arbitration when the seller lets their window lapse.
   *
   * A seller who ignores a dispute must not be able to stall it indefinitely, and the buyer
   * should not have to chase them (DISPUTE_SYSTEM.md).
   */
  async function escalateDisputes(now: Date): Promise<number> {
    const db = mongoose.connection.db;
    if (!db) return 0;
    const overdue = await db
      .collection<{ _id: mongoose.Types.ObjectId }>('disputes')
      .find({ status: 'OPEN', sellerResponseDeadline: { $lte: now } })
      .limit(BATCH_SIZE)
      .toArray();
    if (overdue.length === 0) return 0;

    let moved = 0;
    let failed = 0;
    for (const dispute of overdue) {
      // One bad row must not end the batch, and must not end the three sweeps that run
      // after this one — a deterministic failure here would otherwise block commission
      // charging and dispute escalation for as long as the row survives.
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const updated = await db
            .collection('disputes')
            .updateOne(
              { _id: dispute._id, status: 'OPEN' },
              { $set: { status: 'UNDER_REVIEW', sellerRespondedAt: null } },
              { session },
            );
          // The seller answered in the same instant; their write wins.
          if (updated.modifiedCount !== 1) return;
          await db.collection('outbox').insertOne(
            {
              eventId: crypto.randomUUID(),
              type: 'dispute.escalated',
              version: 1,
              aggregateType: 'dispute',
              aggregateId: dispute._id.toString(),
              payload: { disputeId: dispute._id.toString(), reason: 'Seller did not respond in time' },
              traceId: null,
              actorId: null,
              actorType: 'SYSTEM',
              occurredAt: now,
              publishedAt: null,
              attempts: 0,
              lastError: null,
              createdAt: now,
              updatedAt: now,
            },
            { session },
          );
          moved += 1;
        });
      } catch (error) {
        failed += 1;
        logger.error({ err: error, disputeId: dispute._id.toString() }, 'sweep step failed: escalating a dispute');
      } finally {
        await session.endSession();
      }
    }
    logger.info({ count: moved, failed }, 'disputes escalated for no seller response');
    return moved;
  }

  /**
   * The four sweeps run independently.
   *
   * They were chained with `+`, which meant a throw in the first prevented the other three from
   * running at all — an unexpirable order would have stopped commission being charged and
   * disputes being escalated, indefinitely, while the log showed only the first failure. They
   * answer separate questions and share nothing but a clock.
   */
  async function sweepOnce(): Promise<number> {
    const now = new Date();
    const steps: [string, () => Promise<number>][] = [
      ['expireUnaccepted', () => expireUnaccepted(now)],
      ['autoComplete', () => autoComplete(now)],
      ['expireAdjustments', () => expireAdjustments(now)],
      ['escalateDisputes', () => escalateDisputes(now)],
    ];

    let total = 0;
    for (const [name, step] of steps) {
      try {
        total += await step();
      } catch (error) {
        logger.error({ err: error, step: name }, 'order timer sweep step failed');
      }
    }
    return total;
  }

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    const lock = await acquireLock(redis, 'order-timers', LOCK_TTL_MS);
    if (!lock) {
      running = false;
      return;
    }
    try {
      await sweepOnce();
    } catch (error) {
      logger.error({ err: error }, 'order timer sweep failed');
    } finally {
      await lock.release();
      running = false;
    }
  }

  return {
    start(): void {
      timer = setInterval(() => void tick(), INTERVAL_MS);
      logger.info({ intervalMs: INTERVAL_MS }, 'order timers started');
      void tick();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
      logger.info('order timers stopped');
    },
    sweepOnce,
    expireUnaccepted,
    autoComplete,
    expireAdjustments,
    escalateDisputes,
  };
}
