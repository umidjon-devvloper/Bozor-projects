import mongoose from 'mongoose';
import type { Redis } from 'ioredis';
import type { Logger } from '@bozorlar/logger';
import { acquireLock } from './lock.js';

const INTERVAL_MS = 15 * 60_000;
const LOCK_TTL_MS = 14 * 60_000;
const BATCH_SIZE = 200;
const UNATTACHED_TTL_MS = 24 * 60 * 60 * 1000;

interface AssetRow {
  _id: mongoose.Types.ObjectId;
  mediaKey: string;
  bucket: string;
  status: string;
  variants: Array<{ key: string }>;
}

export interface StorageRemover {
  deleteObject(bucket: string, key: string): Promise<void>;
  tempBucket: string;
}

/**
 * Reclaims storage for assets that were never completed or never used.
 *
 * Two populations leak without this. A user who requests an upload ticket and abandons the
 * flow leaves a PENDING row forever; a user who uploads five product photos and saves only
 * three leaves two CONFIRMED but unattached objects that nothing will ever reference. Neither
 * shows up as an error, which is exactly why it needs a scheduled job rather than a hope.
 *
 * The database row is retained as ORPHANED rather than deleted: it is the only record that
 * the object once existed, and it is what makes a storage-versus-database reconciliation
 * possible later.
 */
export function createOrphanMediaSweeper(redis: Redis, storage: StorageRemover, logger: Logger) {
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  async function removeObjects(asset: AssetRow): Promise<void> {
    for (const variant of asset.variants) {
      await storage.deleteObject(asset.bucket, variant.key).catch((error: unknown) => {
        logger.warn({ err: error, key: variant.key }, 'failed to delete variant');
      });
    }
    await storage.deleteObject(asset.bucket, asset.mediaKey).catch(() => undefined);
    // A PENDING asset may still be sitting in the temp bucket under the same key.
    await storage.deleteObject(storage.tempBucket, asset.mediaKey).catch(() => undefined);
  }

  async function sweepOnce(): Promise<number> {
    const db = mongoose.connection.db;
    if (!db) return 0;
    const collection = db.collection<AssetRow>('media_assets');
    const now = new Date();

    const candidates = await collection
      .find({
        $or: [
          { status: 'PENDING', expiresAt: { $lte: now } },
          { status: 'CONFIRMED', confirmedAt: { $lte: new Date(now.getTime() - UNATTACHED_TTL_MS) } },
        ],
      })
      .limit(BATCH_SIZE)
      .toArray();

    if (candidates.length === 0) return 0;

    /**
     * Claim the asset before deleting anything it points at.
     *
     * The candidates were read a moment ago, and a seller attaching an image to a product in
     * that window would have had the file deleted underneath them — the product would carry a
     * broken image and the asset row would say ORPHANED, so nothing would ever restore it.
     * Deleting first and marking afterwards makes that window as wide as an object-store call.
     *
     * The compare-and-set is on the status the candidate was found with, so an asset that has
     * moved on since is skipped and keeps its files.
     */
    let reclaimed = 0;
    for (const asset of candidates) {
      const claimed = await collection.updateOne(
        { _id: asset._id, status: asset.status },
        { $set: { status: 'ORPHANED', updatedAt: now } },
      );
      if (claimed.modifiedCount !== 1) continue;

      await removeObjects(asset);
      reclaimed += 1;
    }

    logger.info({ count: reclaimed, considered: candidates.length }, 'orphaned media reclaimed');
    return reclaimed;
  }

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    const lock = await acquireLock(redis, 'orphan-media-sweeper', LOCK_TTL_MS);
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
      logger.error({ err: error }, 'orphan media sweep failed');
    } finally {
      await lock.release();
      running = false;
    }
  }

  return {
    start(): void {
      timer = setInterval(() => void tick(), INTERVAL_MS);
      logger.info({ intervalMs: INTERVAL_MS }, 'orphan media sweeper started');
      void tick();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
      logger.info('orphan media sweeper stopped');
    },
    sweepOnce,
  };
}
