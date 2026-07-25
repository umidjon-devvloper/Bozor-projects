import mongoose from 'mongoose';
import type { Logger } from '@bozorlar/logger';
import type { DomainEventEnvelope } from '../eventDispatcher.js';
import { text } from '../payload.js';

/**
 * Propagates a shop's visibility onto its products.
 *
 * The geo module materialises `shop.isVisible` on write; without this handler the products
 * inside that shop keep their own stale flag, and a seller whose wallet ran dry would keep
 * selling through the product listing even though their shop page had gone. That is the
 * exact divergence the single visibility rule exists to prevent (MARKET_SYSTEM.md).
 *
 * Idempotent: applying the same visibility twice is a no-op at the database level, which is
 * what makes at-least-once delivery safe here.
 */
export function createShopVisibilityHandler(logger: Logger) {
  return async function handle(event: DomainEventEnvelope): Promise<void> {
    const db = mongoose.connection.db;
    if (!db) throw new Error('No database connection');

    const shopId = text(event.payload.shopId, event.aggregateId);
    const shopVisible = event.payload.isVisible === true;
    const now = new Date();
    const products = db.collection('products');

    if (!shopVisible) {
      const hidden = await products.updateMany(
        { shopId: new mongoose.Types.ObjectId(shopId), deletedAt: null },
        {
          $set: {
            shopVisible: false,
            isVisible: false,
            visibilityReason: 'SHOP_NOT_VISIBLE',
            visibilityComputedAt: now,
          },
        },
      );
      if (hidden.modifiedCount > 0) {
        logger.info({ shopId, hidden: hidden.modifiedCount }, 'products hidden with shop');
      }
      return;
    }

    // Turning a shop back on cannot blanket-publish its catalogue: a product that is still
    // in draft or awaiting moderation stays hidden on its own merits.
    await products.updateMany(
      { shopId: new mongoose.Types.ObjectId(shopId), deletedAt: null },
      { $set: { shopVisible: true, visibilityComputedAt: now } },
    );
    const shown = await products.updateMany(
      {
        shopId: new mongoose.Types.ObjectId(shopId),
        deletedAt: null,
        status: { $in: ['ACTIVE', 'OUT_OF_STOCK'] },
        moderationStatus: 'APPROVED',
      },
      { $set: { isVisible: true, visibilityReason: 'VISIBLE', visibilityComputedAt: now } },
    );
    if (shown.modifiedCount > 0) {
      logger.info({ shopId, shown: shown.modifiedCount }, 'products restored with shop');
    }
  };
}
