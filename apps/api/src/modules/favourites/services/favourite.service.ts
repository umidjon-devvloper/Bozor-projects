import mongoose, { type ClientSession } from 'mongoose';
import { AppError, ErrorCode, conflict, notFound } from '@bozorlar/errors';
import type { Logger } from '@bozorlar/logger';
import { isPurchasable } from '@bozorlar/domain';
import {
  FavouriteTarget,
  MAX_FAVOURITES_PER_USER,
  favouriteRepository,
  type FavouriteRecord,
} from '@bozorlar/favourites';
import type { ProductRecord, ProductService } from '../../catalog/index.js';
import type { ShopService } from '../../geo/index.js';
import { outboxService } from '../../outbox/index.js';
import { FavouriteEvents } from '../events.js';
import { ActorType } from '@bozorlar/types';

export interface FavouriteProductItem {
  favourite: FavouriteRecord;
  product: ProductRecord | null;
  purchasable: boolean;
}

export interface FavouriteShopItem {
  favourite: FavouriteRecord;
  shop: { id: string; name: unknown; slug: string; isVisible: boolean; marketId: string } | null;
}

/**
 * Keeps `products.favoriteCount` in step.
 *
 * Written here rather than by the catalogue for the same reason the review module writes
 * `ratingSum`: the count is a projection of this module's data, and the module that owns the
 * data owns the projection. A single `$inc` with a floor at zero, so a double-delete can
 * never drive a public counter negative.
 */
async function bumpFavouriteCount(
  productId: string,
  delta: number,
  session: ClientSession,
): Promise<void> {
  const db = mongoose.connection.db;
  if (!db || !mongoose.Types.ObjectId.isValid(productId)) return;
  await db.collection('products').updateOne(
    { _id: new mongoose.Types.ObjectId(productId) },
    [
      {
        $set: {
          favoriteCount: {
            $max: [0, { $add: [{ $ifNull: ['$favoriteCount', 0] }, delta] }],
          },
        },
      },
    ],
    { session },
  );
}

export function createFavouriteService(deps: {
  products: ProductService;
  shops: ShopService;
  logger: Logger;
}) {
  const { products, shops, logger } = deps;

  async function loadProduct(productId: string): Promise<ProductRecord> {
    const found = await products.findForCheckout([productId]);
    const product = found.get(productId);
    if (!product) {
      throw new AppError(ErrorCode.FAVOURITE_TARGET_NOT_FOUND, {
        detail: 'That product no longer exists',
      });
    }
    return product;
  }

  function purchasableNow(product: ProductRecord): boolean {
    return isPurchasable({
      isVisible: product.isVisible,
      availableQtyMilli: BigInt(product.availableQty.toStorage()),
      minOrderQtyMilli: BigInt(product.minOrderQty.toStorage()),
    });
  }

  return {
    /**
     * Follows a product or a shop.
     *
     * Idempotent by construction: the unique index makes a repeat an upsert that changes
     * nothing, and only a genuine insert moves the counter or emits an event. Tapping a heart
     * twice on a flaky connection is normal behaviour, not an error to report back.
     */
    async add(
      userId: string,
      input: { targetType: FavouriteTarget; targetId: string },
    ): Promise<FavouriteRecord> {
      const total = await favouriteRepository.countForUser(userId);
      if (total >= MAX_FAVOURITES_PER_USER) {
        throw conflict(
          ErrorCode.FAVOURITE_LIMIT_REACHED,
          `A person may follow at most ${MAX_FAVOURITES_PER_USER} items`,
        );
      }

      let shopId: string | null = null;
      let initialState = {
        priceWatermarkMinor: null as bigint | null,
        wasPurchasable: false,
        lastPriceAlertAt: null as Date | null,
        lastRestockAlertAt: null as Date | null,
      };

      if (input.targetType === FavouriteTarget.PRODUCT) {
        const product = await loadProduct(input.targetId);
        shopId = product.shopId;
        /**
         * The watermark starts at today's price, and `wasPurchasable` at today's truth.
         *
         * Starting the watermark at zero would make the first price change look like a rise;
         * starting `wasPurchasable` at false would fire a restock alert for something that
         * was never out of stock, seconds after the person favourited it.
         */
        initialState = {
          priceWatermarkMinor: BigInt(product.price.toStorage()),
          wasPurchasable: purchasableNow(product),
          lastPriceAlertAt: null,
          lastRestockAlertAt: null,
        };
      } else {
        const shop = await shops.getPublic(input.targetId).catch(() => null);
        if (!shop) {
          throw new AppError(ErrorCode.FAVOURITE_TARGET_NOT_FOUND, {
            detail: 'That shop no longer exists',
          });
        }
        shopId = shop.id;
      }

      /**
       * The favourite, the product counter and the event move together or not at all.
       *
       * `favoriteCount` is displayed on a public product card, and the outbox row is what the
       * alerting worker eventually reads. A favourite that exists without its counter, or
       * without its event, is a small inconsistency that nothing would ever repair.
       */
      const session = await mongoose.startSession();
      try {
        return await session.withTransaction(async () => {
          const { record, created } = await favouriteRepository.add(
            {
              userId,
              targetType: input.targetType,
              targetId: input.targetId,
              shopId,
              initialState,
            },
            session,
          );

          if (created) {
            if (input.targetType === FavouriteTarget.PRODUCT) {
              await bumpFavouriteCount(input.targetId, 1, session);
            }
            await outboxService.publish(
              {
                type: FavouriteEvents.ADDED,
                aggregateType: 'favourite',
                aggregateId: record.id,
                payload: {
                  favouriteId: record.id,
                  userId,
                  targetType: input.targetType,
                  targetId: input.targetId,
                  shopId,
                },
                actorId: userId,
                actorType: ActorType.USER,
              },
              session,
            );
          }

          return record;
        });
      } finally {
        await session.endSession();
      }
    },

    async remove(
      userId: string,
      targetType: FavouriteTarget,
      targetId: string,
    ): Promise<void> {
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const removed = await favouriteRepository.remove(userId, targetType, targetId, session);
          if (!removed) throw notFound('Favourite');

          if (targetType === FavouriteTarget.PRODUCT) {
            await bumpFavouriteCount(targetId, -1, session);
          }
          await outboxService.publish(
            {
              type: FavouriteEvents.REMOVED,
              aggregateType: 'favourite',
              aggregateId: targetId,
              payload: { userId, targetType, targetId },
              actorId: userId,
              actorType: ActorType.USER,
            },
            session,
          );
        });
      } finally {
        await session.endSession();
      }
    },

    /**
     * The buyer's followed products, each with what it costs and whether it can be bought now.
     *
     * The product is fetched in one bulk call rather than per row. A product that has since
     * been archived comes back as `null` and is rendered as unavailable rather than dropped:
     * silently removing rows from somebody's own list is more confusing than showing them a
     * card that says the seller withdrew it.
     */
    async listProducts(
      userId: string,
      page: { limit: number; cursor: string | null },
    ): Promise<{ items: FavouriteProductItem[]; nextCursor: string | null }> {
      const rows = await favouriteRepository.listForUser({
        userId,
        targetType: FavouriteTarget.PRODUCT,
        limit: page.limit,
        beforeId: page.cursor,
      });
      const hasMore = rows.length > page.limit;
      const visible = hasMore ? rows.slice(0, page.limit) : rows;
      const found = await products.findForCheckout(visible.map((row) => row.targetId));

      const items = visible.map((favourite) => {
        const product = found.get(favourite.targetId) ?? null;
        return {
          favourite,
          product,
          purchasable: product ? purchasableNow(product) : false,
        };
      });
      const last = visible[visible.length - 1];
      return { items, nextCursor: hasMore && last ? last.id : null };
    },

    async listShops(
      userId: string,
      page: { limit: number; cursor: string | null },
    ): Promise<{ items: FavouriteShopItem[]; nextCursor: string | null }> {
      const rows = await favouriteRepository.listForUser({
        userId,
        targetType: FavouriteTarget.SHOP,
        limit: page.limit,
        beforeId: page.cursor,
      });
      const hasMore = rows.length > page.limit;
      const visible = hasMore ? rows.slice(0, page.limit) : rows;

      const items: FavouriteShopItem[] = [];
      for (const favourite of visible) {
        const shop = await shops.getPublic(favourite.targetId).catch(() => null);
        items.push({
          favourite,
          shop: shop
            ? {
                id: shop.id,
                name: shop.name,
                slug: shop.slug,
                isVisible: shop.isVisible,
                marketId: shop.marketId,
              }
            : null,
        });
      }
      const last = visible[visible.length - 1];
      return { items, nextCursor: hasMore && last ? last.id : null };
    },

    /** Which of these the user already follows, for rendering a page of hearts. */
    async status(
      userId: string,
      targetType: FavouriteTarget,
      targetIds: readonly string[],
    ): Promise<string[]> {
      return favouriteRepository.filterFollowed(userId, targetType, targetIds);
    },

    async setAlerts(
      userId: string,
      productId: string,
      enabled: boolean,
    ): Promise<FavouriteRecord> {
      const record = await favouriteRepository.setAlertsEnabled(userId, productId, enabled);
      if (!record) throw notFound('Favourite');
      return record;
    },

    /**
     * How many people are waiting on a product, for the seller's own dashboard.
     *
     * `awaitingRestock` is the number the seller can act on: people who followed the product
     * and last saw it unavailable. It is the closest thing the platform has to a demand
     * signal for something that is not currently for sale.
     */
    async followerCounts(
      productId: string,
      actorShopIds: readonly string[],
    ): Promise<{ productId: string; followers: number; awaitingRestock: number }> {
      const product = await loadProduct(productId);
      if (!actorShopIds.includes(product.shopId)) {
        // ADR-0029: a seller asking about somebody else's product is told it does not exist.
        throw notFound('Product', `FAVOURITE_SCOPE_DENIED product=${productId}`);
      }
      const followers = await favouriteRepository.countFollowers(
        FavouriteTarget.PRODUCT,
        productId,
      );
      const db = mongoose.connection.db;
      const awaitingRestock = db
        ? await db.collection('favourites').countDocuments({
            targetType: FavouriteTarget.PRODUCT,
            targetId: new mongoose.Types.ObjectId(productId),
            wasPurchasable: false,
            alertsEnabled: true,
          })
        : 0;
      logger.debug({ productId, followers, awaitingRestock }, 'favourite counts read');
      return { productId, followers, awaitingRestock };
    },
  };
}

export type FavouriteService = ReturnType<typeof createFavouriteService>;
