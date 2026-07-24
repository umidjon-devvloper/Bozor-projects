import mongoose from 'mongoose';
import type { Redis } from 'ioredis';
import type { Logger } from '@bozorlar/logger';
import { computeShopVisibility } from '@bozorlar/domain';
import type { MarketStatus, ModerationStatus, ShopStatus } from '@bozorlar/types';
import { acquireLock } from './lock.js';

const INTERVAL_MS = 60_000;
const LOCK_TTL_MS = 55_000;
const BATCH_SIZE = 500;

interface ShopRow {
  _id: mongoose.Types.ObjectId;
  marketId: mongoose.Types.ObjectId;
  status: ShopStatus;
  moderationStatus: ModerationStatus;
  sellerWalletActive: boolean;
  vacationUntil: Date | null;
  isVisible: boolean;
  visibilityReason: string;
}

/**
 * Restores shops whose vacation has expired.
 *
 * Visibility is materialized on write, which covers every state change the API makes. One
 * input changes on its own, without anyone touching the shop: `vacationUntil` passing. With
 * no sweeper a seller's shop stays hidden after their holiday ends until they happen to edit
 * something — a silent, revenue-losing failure that nobody reports because nothing errored.
 *
 * The rule itself is not reimplemented here. The same pure function the API uses is applied
 * to each row, so the two can never disagree.
 */
export function createVisibilitySweeper(redis: Redis, logger: Logger) {
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  async function sweepOnce(): Promise<number> {
    const db = mongoose.connection.db;
    if (!db) return 0;

    const now = new Date();
    const shops = db.collection<ShopRow>('shops');

    const expired = await shops
      .find({ vacationUntil: { $ne: null, $lte: now }, deletedAt: null })
      .limit(BATCH_SIZE)
      .toArray();
    if (expired.length === 0) return 0;

    // One lookup for the whole batch rather than one per shop.
    const marketIds = [...new Set(expired.map((shop) => shop.marketId.toString()))];
    const markets = await db
      .collection<{ _id: mongoose.Types.ObjectId; status: MarketStatus }>('markets')
      .find({ _id: { $in: marketIds.map((id) => new mongoose.Types.ObjectId(id)) } })
      .project<{ _id: mongoose.Types.ObjectId; status: MarketStatus }>({ status: 1 })
      .toArray();
    const marketStatus = new Map(markets.map((market) => [market._id.toString(), market.status]));

    const operations = [];
    for (const shop of expired) {
      const status = marketStatus.get(shop.marketId.toString());
      if (!status) continue;

      const result = computeShopVisibility({
        shopStatus: shop.status,
        moderationStatus: shop.moderationStatus,
        marketStatus: status,
        sellerWalletActive: shop.sellerWalletActive,
        // The vacation is over, so it is no longer an input.
        vacationUntil: null,
        now,
      });

      operations.push({
        updateOne: {
          filter: { _id: shop._id },
          update: {
            $set: {
              vacationUntil: null,
              isVisible: result.isVisible,
              visibilityReason: result.reason,
              visibilityComputedAt: now,
            },
          },
        },
      });
    }

    if (operations.length === 0) return 0;
    // ordered: false so one failing document does not abandon the rest of the batch.
    await shops.bulkWrite(operations, { ordered: false });
    logger.info({ count: operations.length }, 'vacation expiry sweep applied');
    return operations.length;
  }

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    const lock = await acquireLock(redis, 'visibility-sweeper', LOCK_TTL_MS);
    if (!lock) {
      running = false;
      return;
    }
    try {
      // Drain fully: a long holiday season can expire more than one batch at once.
      let processed: number;
      do {
        processed = await sweepOnce();
      } while (processed === BATCH_SIZE);
    } catch (error) {
      logger.error({ err: error }, 'visibility sweep failed');
    } finally {
      await lock.release();
      running = false;
    }
  }

  return {
    start(): void {
      timer = setInterval(() => void tick(), INTERVAL_MS);
      logger.info({ intervalMs: INTERVAL_MS }, 'visibility sweeper started');
      void tick();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
      logger.info('visibility sweeper stopped');
    },
    sweepOnce,
  };
}
