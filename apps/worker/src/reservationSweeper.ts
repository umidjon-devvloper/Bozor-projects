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
    let released = 0;
    try {
      await session.withTransaction(async () => {
        released = 0;
        for (const reservation of expired) {
          /**
           * Claim the reservation before releasing its stock, not after.
           *
           * The rows were read outside this transaction, and an order expiring through
           * `releaseStockFor` releases the same reservations. Decrementing first and updating
           * the status afterwards — with the status filter only on the update — meant both
           * paths could decrement the same reservation while only one of them changed its
           * status. `reservedQtyMilli` would fall twice for one hold, the product would look
           * like it had more stock than it does, and the bazaar would sell goods that are not
           * there.
           *
           * The compare-and-set decides who owns the release; only the winner touches stock.
           */
          const claimed = await db.collection('stock_reservations').updateOne(
            { _id: reservation._id, status: 'ACTIVE' },
            { $set: { status: 'EXPIRED', releasedAt: now } },
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
          released += 1;
        }
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

    logger.info({ count: released, found: expired.length }, 'expired stock reservations released');
    return released;
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
