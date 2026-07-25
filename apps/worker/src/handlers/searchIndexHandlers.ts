import type { SearchIndexer } from '@bozorlar/search';
import type { Logger } from '@bozorlar/logger';
import type { DomainEventEnvelope } from '../eventDispatcher.js';
import { text } from '../payload.js';
import type { Types as MongooseTypes } from 'mongoose';

/**
 * Keeps the search index in step with the catalogue.
 *
 * Every handler is a re-read and an upsert rather than a patch derived from the event payload:
 * the event says *what changed*, the database says *what it now is*, and only the second is
 * safe to index under at-least-once delivery where events can arrive out of order.
 *
 * `indexProduct` and `indexShop` delete rather than skip when a document is no longer publicly
 * visible, which is what keeps a hidden product out of results instead of merely stale.
 */
export function registerSearchIndexHandlers(
  on: (type: string, handler: (event: DomainEventEnvelope) => Promise<void>) => void,
  indexer: SearchIndexer,
  logger: Logger,
): void {
  const productEvents = [
    'product.created',
    'product.updated',
    'product.price_changed',
    'product.stock_changed',
    'product.moderation_decided',
    'product.visibility_changed',
    'product.archived',
    // Ranking is driven by the Bayesian rating, so a new review moves search results.
    'review.rating_changed',
  ];

  for (const type of productEvents) {
    on(type, async (event) => {
      const productId = text(event.payload.productId, event.aggregateId);
      const outcome = await indexer.indexProduct(productId);
      logger.debug({ productId, type, outcome }, 'search index updated');
    });
  }

  for (const type of ['shop.created', 'shop.updated', 'shop.moderation_decided']) {
    on(type, async (event) => {
      const shopId = text(event.payload.shopId, event.aggregateId);
      await indexer.indexShop(shopId);
    });
  }

  /**
   * A shop appearing or disappearing takes its whole catalogue with it.
   *
   * This is the fan-out cost of denormalising the shop name onto every product document. It is
   * paid on a rare event rather than on every search, which is the right way round.
   */
  on('shop.visibility_changed', async (event) => {
    const shopId = text(event.payload.shopId, event.aggregateId);
    await indexer.indexShop(shopId);
    const products = await indexer.reindexShopProducts(shopId);
    logger.info({ shopId, products, visible: event.payload.isVisible }, 'shop visibility fanned out to search');
  });

  /** A seller running out of balance hides their shop, and with it everything they sell. */
  for (const type of ['seller.deactivated', 'seller.reactivated']) {
    on(type, async (event) => {
      const sellerId = text(event.payload.sellerId);
      if (!sellerId) return;
      const mongoose = await import('mongoose');
      const db = mongoose.default.connection.db;
      if (!db) return;
      const shops = await db
        .collection<{ _id: MongooseTypes.ObjectId }>('shops')
        .find({ ownerId: new mongoose.default.Types.ObjectId(sellerId), deletedAt: null })
        .project<{ _id: MongooseTypes.ObjectId }>({ _id: 1 })
        .toArray();
      for (const shop of shops) {
        await indexer.indexShop(shop._id.toString());
        await indexer.reindexShopProducts(shop._id.toString());
      }
      logger.info({ sellerId, shops: shops.length, type }, 'seller wallet state fanned out to search');
    });
  }

  logger.info({ events: productEvents.length + 6 }, 'search index handlers registered');
}
