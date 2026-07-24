import mongoose from 'mongoose';
import type { LocalizedText } from '@bozorlar/types';
import { ALIAS, IMPORT_BATCH_SIZE, SearchCollection } from './constants.js';
import { productSchema, shopSchema, versionedName } from './schemas.js';
import {
  toProductDocument,
  toShopDocument,
  type ProductSource,
  type ShopSource,
} from './documents.js';
import type { TypesenseClient } from './client.js';

export interface IndexerLogger {
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

interface ShopRow extends ShopSource {
  isVisible: boolean;
  deletedAt: Date | null;
}

/**
 * Keeps the search index in step with the catalogue.
 *
 * Only visible products and shops are indexed. That is the important rule: the index is a
 * public surface, and a hidden product appearing in search results would leak exactly what
 * the visibility rule exists to hide (MARKET_SYSTEM.md).
 */
export function createIndexer(client: TypesenseClient, logger: IndexerLogger) {
  async function shopContext(shopId: mongoose.Types.ObjectId) {
    const db = mongoose.connection.db;
    if (!db) return null;
    const shop = await db
      .collection<ShopRow>('shops')
      .findOne({ _id: shopId }, { projection: { name: 1, marketId: 1, location: 1, isVisible: 1 } });
    if (!shop) return null;
    const market = await db
      .collection<{ _id: mongoose.Types.ObjectId; name: LocalizedText; location: { coordinates: [number, number] } }>('markets')
      .findOne({ _id: shop.marketId });
    return {
      visible: shop.isVisible,
      context: {
        name: shop.name,
        marketName: market?.name,
        location: (shop.location?.coordinates ?? market?.location.coordinates) as [number, number] | undefined,
      },
    };
  }

  return {
    /** Creates both collections behind their aliases if the cluster is empty. */
    async ensureCollections(): Promise<void> {
      for (const [alias, schema] of [
        [ALIAS.products, productSchema],
        [ALIAS.shops, shopSchema],
      ] as const) {
        const existing = await client.resolveAlias(alias);
        if (existing) continue;
        const physical = versionedName(alias);
        await client.createCollection(schema(physical));
        await client.upsertAlias(alias, physical);
        logger.info({ alias, physical }, 'search collection created');
      }
    },

    async indexProduct(productId: string): Promise<'indexed' | 'removed' | 'skipped'> {
      const db = mongoose.connection.db;
      if (!db || !mongoose.Types.ObjectId.isValid(productId)) return 'skipped';

      const product = await db
        .collection<ProductSource & { isVisible: boolean; deletedAt: Date | null }>('products')
        .findOne({ _id: new mongoose.Types.ObjectId(productId) });

      // Anything not publicly visible is removed rather than skipped: a product that was
      // indexed and then hidden must disappear from results, not merely stop being refreshed.
      if (!product || !product.isVisible || product.deletedAt !== null) {
        await client.deleteDocument(SearchCollection.PRODUCTS, productId);
        return 'removed';
      }

      const shop = await shopContext(product.shopId);
      if (!shop || !shop.visible) {
        await client.deleteDocument(SearchCollection.PRODUCTS, productId);
        return 'removed';
      }

      const category = await db
        .collection<{ _id: mongoose.Types.ObjectId; name: LocalizedText }>('categories')
        .findOne({ _id: product.categoryId }, { projection: { name: 1 } });

      await client.upsertDocument(
        SearchCollection.PRODUCTS,
        toProductDocument(product, shop.context, category?.name) as unknown as Record<string, unknown>,
      );
      return 'indexed';
    },

    async indexShop(shopId: string): Promise<'indexed' | 'removed' | 'skipped'> {
      const db = mongoose.connection.db;
      if (!db || !mongoose.Types.ObjectId.isValid(shopId)) return 'skipped';

      const shop = await db
        .collection<ShopRow>('shops')
        .findOne({ _id: new mongoose.Types.ObjectId(shopId) });
      if (!shop || !shop.isVisible || shop.deletedAt !== null) {
        await client.deleteDocument(SearchCollection.SHOPS, shopId);
        return 'removed';
      }

      const market = await db
        .collection<{ _id: mongoose.Types.ObjectId; name: LocalizedText; location: { coordinates: [number, number] } }>('markets')
        .findOne({ _id: shop.marketId });

      await client.upsertDocument(
        SearchCollection.SHOPS,
        toShopDocument(shop, market?.name, market?.location.coordinates) as unknown as Record<string, unknown>,
      );
      return 'indexed';
    },

    /**
     * Reindexes every product belonging to a shop.
     *
     * The cost of denormalising the shop name onto each product: a rename, or a shop going
     * dark, has to fan out. Bounded and batched, and rare enough that the read-side saving is
     * worth it many times over.
     */
    async reindexShopProducts(shopId: string): Promise<number> {
      const db = mongoose.connection.db;
      if (!db || !mongoose.Types.ObjectId.isValid(shopId)) return 0;

      const cursor = db
        .collection<{ _id: mongoose.Types.ObjectId }>('products')
        .find({ shopId: new mongoose.Types.ObjectId(shopId), deletedAt: null }, { projection: { _id: 1 } });

      let count = 0;
      for await (const row of cursor) {
        await this.indexProduct(row._id.toString());
        count += 1;
      }
      logger.info({ shopId, products: count }, 'shop products reindexed');
      return count;
    },

    async removeProduct(productId: string): Promise<void> {
      await client.deleteDocument(SearchCollection.PRODUCTS, productId);
    },

    async removeShop(shopId: string): Promise<void> {
      await client.deleteDocument(SearchCollection.SHOPS, shopId);
    },

    /**
     * Rebuilds both indexes from scratch behind a new alias.
     *
     * Builds into a fresh versioned collection and repoints the alias only once the import has
     * finished, so search keeps serving the previous index throughout and a failed rebuild
     * changes nothing. The old collection is dropped afterwards, not before.
     */
    async reindexAll(): Promise<{ products: number; shops: number }> {
      const db = mongoose.connection.db;
      if (!db) throw new Error('No database connection');

      const productsPhysical = versionedName(ALIAS.products);
      const shopsPhysical = versionedName(ALIAS.shops);
      const previousProducts = await client.resolveAlias(ALIAS.products);
      const previousShops = await client.resolveAlias(ALIAS.shops);

      await client.createCollection(productSchema(productsPhysical));
      await client.createCollection(shopSchema(shopsPhysical));
      logger.info({ productsPhysical, shopsPhysical }, 'rebuilding search indexes');

      const marketCache = new Map<string, { name: LocalizedText; coordinates: [number, number] }>();
      const shopCache = new Map<
        string,
        { name: LocalizedText; marketId: string; visible: boolean; location: [number, number] | undefined }
      >();
      let shopCount = 0;

      let batch: Array<Record<string, unknown>> = [];
      const flush = async (collection: string): Promise<void> => {
        if (batch.length === 0) return;
        const result = await client.importDocuments(collection, batch);
        if (result.failed.length > 0) {
          logger.error({ collection, failed: result.failed.length }, 'search import rejected documents');
        }
        batch = [];
      };

      for await (const shop of db.collection<ShopRow>('shops').find({ isVisible: true, deletedAt: null })) {
        const marketId = shop.marketId.toString();
        if (!marketCache.has(marketId)) {
          const market = await db
            .collection<{ name: LocalizedText; location: { coordinates: [number, number] } }>('markets')
            .findOne({ _id: shop.marketId });
          if (market) marketCache.set(marketId, { name: market.name, coordinates: market.location.coordinates });
        }
        const market = marketCache.get(marketId);
        shopCache.set(shop._id.toString(), {
          name: shop.name,
          marketId,
          visible: true,
          location: (shop.location?.coordinates ?? market?.coordinates) as [number, number] | undefined,
        });
        batch.push(toShopDocument(shop, market?.name, market?.coordinates) as unknown as Record<string, unknown>);
        shopCount += 1;
        if (batch.length >= IMPORT_BATCH_SIZE) await flush(shopsPhysical);
      }
      await flush(shopsPhysical);

      const categoryCache = new Map<string, LocalizedText>();
      let productCount = 0;

      for await (const product of db
        .collection<ProductSource & { isVisible: boolean; deletedAt: Date | null }>('products')
        .find({ isVisible: true, deletedAt: null })) {
        const shop = shopCache.get(product.shopId.toString());
        // A product whose shop is not itself indexed must not appear: the two views of
        // visibility have to agree.
        if (!shop) continue;

        const categoryId = product.categoryId.toString();
        if (!categoryCache.has(categoryId)) {
          const category = await db
            .collection<{ name: LocalizedText }>('categories')
            .findOne({ _id: product.categoryId }, { projection: { name: 1 } });
          if (category) categoryCache.set(categoryId, category.name);
        }

        batch.push(
          toProductDocument(
            product,
            {
              name: shop.name,
              marketName: marketCache.get(shop.marketId)?.name,
              location: shop.location,
            },
            categoryCache.get(categoryId),
          ) as unknown as Record<string, unknown>,
        );
        productCount += 1;
        if (batch.length >= IMPORT_BATCH_SIZE) await flush(productsPhysical);
      }
      await flush(productsPhysical);

      // The swap. Everything before this point was invisible to search traffic.
      await client.upsertAlias(ALIAS.products, productsPhysical);
      await client.upsertAlias(ALIAS.shops, shopsPhysical);

      for (const [previous, next] of [
        [previousProducts, productsPhysical],
        [previousShops, shopsPhysical],
      ] as const) {
        if (previous && previous !== next) await client.dropCollection(previous);
      }

      logger.info({ products: productCount, shops: shopCount }, 'search reindex complete');
      return { products: productCount, shops: shopCount };
    },
  };
}

export type SearchIndexer = ReturnType<typeof createIndexer>;
