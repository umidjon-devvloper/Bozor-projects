import mongoose from 'mongoose';
import { isPurchasable } from '@bozorlar/domain';
import { AlertKind, createFavouriteAlertService, type ProductSnapshot } from '@bozorlar/favourites';
import type { DeliveryService } from '@bozorlar/notifications';
import type { Logger } from '@bozorlar/logger';
import type { DomainEventEnvelope } from '../eventDispatcher.js';

/**
 * Turns catalogue movement into restock and price-drop alerts.
 *
 * Every handler re-reads the product rather than trusting the event payload, for the same
 * reason the search indexer does: at-least-once delivery with no ordering guarantee means the
 * event is a hint that something changed, and only the database knows what it changed to. The
 * decision itself lives in `@bozorlar/favourites` so it can be tested without any of this.
 */

interface ProductRow {
  _id: mongoose.Types.ObjectId;
  shopId: mongoose.Types.ObjectId;
  name: Record<string, string>;
  unit: string;
  price: mongoose.mongo.Long;
  stockQtyMilli: mongoose.mongo.Long;
  reservedQtyMilli: mongoose.mongo.Long;
  minOrderQtyMilli: mongoose.mongo.Long;
  isVisible: boolean;
  status: string;
}

interface ShopRow {
  _id: mongoose.Types.ObjectId;
  name: Record<string, string>;
}

/** Tiyin to a readable som figure, grouped the way a price is written on a stall board. */
function money(minor: bigint): string {
  return (minor / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

async function readProduct(productId: string): Promise<ProductSnapshot | null> {
  const db = mongoose.connection.db;
  if (!db || !mongoose.Types.ObjectId.isValid(productId)) return null;

  const product = await db
    .collection<ProductRow>('products')
    .findOne({ _id: new mongoose.Types.ObjectId(productId) });
  if (!product) return null;

  const shop = await db.collection<ShopRow>('shops').findOne({ _id: product.shopId });

  const stock = BigInt(product.stockQtyMilli.toString());
  const reserved = BigInt(product.reservedQtyMilli.toString());
  const minOrder = BigInt(product.minOrderQtyMilli.toString());
  const priceMinor = BigInt(product.price.toString());

  return {
    productId,
    shopId: product.shopId.toString(),
    // The alert is written in one language for everyone, in the recipient's locale at render
    // time; only the product name is substituted, and it is stored per locale. Uzbek Latin is
    // the fallback because it is the name the seller typed.
    name: product.name.uz ?? Object.values(product.name)[0] ?? '',
    shopName: shop?.name.uz ?? '',
    priceLabel: money(priceMinor),
    priceMinor,
    isVisible: product.isVisible,
    isPurchasable: isPurchasable({
      isVisible: product.isVisible,
      availableQtyMilli: stock - reserved,
      minOrderQtyMilli: minOrder,
    }),
  };
}

export function registerFavouriteAlertHandlers(
  on: (type: string, handler: (event: DomainEventEnvelope) => Promise<void>) => void,
  delivery: DeliveryService,
  logger: Logger,
): void {
  const alerts = createFavouriteAlertService({
    readProduct,
    async notify({ userId, kind, product, dedupeKey }) {
      await delivery.send({
        dedupeKey,
        userId,
        type: kind === AlertKind.RESTOCK ? 'favourite.restocked' : 'favourite.price_dropped',
        targetId: product.productId,
        variables: {
          productName: product.name,
          shopName: product.shopName,
          price: product.priceLabel,
        },
      });
    },
    log(message, fields) {
      logger.info(fields, message);
    },
  });

  /**
   * Price and stock are the two events the alerts exist for.
   *
   * `product.visibility_changed` and `product.moderation_decided` are here too, because a
   * product returning to the catalogue is a restock from the buyer's point of view even when
   * the stock number never moved.
   */
  for (const type of [
    'product.price_changed',
    'product.stock_changed',
    'product.visibility_changed',
    'product.moderation_decided',
    'product.updated',
  ]) {
    on(type, async (event) => {
      const productId = String(event.payload.productId ?? event.aggregateId);
      await alerts.fanOutProduct(productId, event.eventId);
    });
  }

  /**
   * A seller topping up their wallet brings a whole stall back.
   *
   * The shop's visibility cascade has already run by the time this arrives, so every product
   * carries the truth and the per-favourite decision does the rest. No separate "your seller
   * is back" notification: what the buyer followed was the tomatoes.
   */
  on('shop.visibility_changed', async (event) => {
    const shopId = String(event.payload.shopId ?? event.aggregateId);
    await alerts.fanOutShop(shopId, event.eventId);
  });

  logger.info({ events: 6 }, 'favourite alert handlers registered');
}
