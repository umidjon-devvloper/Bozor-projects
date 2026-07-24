import mongoose from 'mongoose';
import type { Redis } from 'ioredis';
import type { Logger } from '@bozorlar/logger';
import { acquireLock } from './lock.js';

const INTERVAL_MS = 60_000;
const LOCK_TTL_MS = 55_000;
const BATCH_SIZE = 500;

interface ReservationRow {
  _id: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  qtyMilli: mongoose.mongo.Long;
}

/**
 * Returns stock held by quotes the buyer never completed.
 *
 * This is the counterpart to the conditional hold in ADR-0032, and it is a job rather than a
 * TTL index for a specific reason: a TTL would delete the reservation row before anything
 * decremented `products.reservedQtyMilli`, leaking the counter upward until the product
 * appeared permanently sold out with stock sitting on the shelf. Deleting the evidence and
 * keeping the effect is the wrong way round.
 *
 * Both writes happen in one transaction, so a crash mid-batch cannot release the record
 * without releasing the stock.
 */
export function createReservationSweeper(redis: Redis, logger: Logger) {
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  async function sweepOnce(): Promise<number> {
    const db = mongoose.connection.db;
    if (!db) return 0;

    const now = new Date();
    const expired = await db
      .collection<ReservationRow>('stock_reservations')
      .find({ status: 'ACTIVE', expiresAt: { $lte: now } })
      .limit(BATCH_SIZE)
      .toArray();
    if (expired.length === 0) return 0;

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        for (const reservation of expired) {
          await db
            .collection('products')
            .updateOne(
              { _id: reservation.productId },
              { $inc: { reservedQtyMilli: reservation.qtyMilli.negate() } },
              { session },
            );
        }
        await db.collection('stock_reservations').updateMany(
          { _id: { $in: expired.map((reservation) => reservation._id) }, status: 'ACTIVE' },
          { $set: { status: 'EXPIRED', releasedAt: now } },
          { session },
        );
        // The quote that held them is retired in the same breath, so a buyer cannot return to
        // a stale offer whose stock has already gone back on sale.
        await db.collection('checkout_quotes').updateMany(
          { status: 'ACTIVE', expiresAt: { $lte: now } },
          { $set: { status: 'EXPIRED' } },
          { session },
        );
      });
    } finally {
      await session.endSession();
    }

    logger.info({ count: expired.length }, 'expired stock reservations released');
    return expired.length;
  }

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    const lock = await acquireLock(redis, 'reservation-sweeper', LOCK_TTL_MS);
    if (!lock) {
      running = false;
      return;
    }
    try {
      let processed: number;
      do {
        processed = await sweepOnce();
      } while (processed === BATCH_SIZE);
    } catch (error) {
      logger.error({ err: error }, 'reservation sweep failed');
    } finally {
      await lock.release();
      running = false;
    }
  }

  return {
    start(): void {
      timer = setInterval(() => void tick(), INTERVAL_MS);
      logger.info({ intervalMs: INTERVAL_MS }, 'reservation sweeper started');
      void tick();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
      logger.info('reservation sweeper stopped');
    },
    sweepOnce,
  };
}
