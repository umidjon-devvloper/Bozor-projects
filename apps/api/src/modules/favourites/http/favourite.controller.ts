import type { Request, Response } from 'express';
import { AppError, ErrorCode } from '@bozorlar/errors';
import { env } from '@bozorlar/config';
import { FavouriteTarget } from '@bozorlar/favourites';
import type { Locale } from '@bozorlar/types';
import { sendCollection, sendCreated, sendData, sendNoContent } from '../../../http/envelope.js';
import type {
  FavouriteProductItem,
  FavouriteService,
  FavouriteShopItem,
} from '../services/favourite.service.js';

interface Actor {
  userId: string;
  shopIds: readonly string[];
}

function requireAuth(req: Request): Actor {
  if (!req.auth) throw new AppError(ErrorCode.AUTH_REQUIRED);
  return { userId: req.auth.userId, shopIds: req.auth.shopIds };
}

function requireParam(value: string | undefined, name: string): string {
  if (!value) throw new AppError(ErrorCode.RESOURCE_NOT_FOUND, { detail: `${name} not found` });
  return value;
}

function parseTargetType(value: string | undefined): FavouriteTarget {
  const upper = (value ?? '').toUpperCase();
  if (upper === FavouriteTarget.PRODUCT || upper === FavouriteTarget.SHOP) return upper;
  throw new AppError(ErrorCode.RESOURCE_NOT_FOUND, { detail: 'Unknown favourite type' });
}

function localized(text: unknown, locale: Locale): string {
  const record = text as Record<string, string> | null;
  if (!record) return '';
  return record[locale] ?? record.uz ?? Object.values(record)[0] ?? '';
}

function cardImage(key: string | undefined): string | null {
  if (!key) return null;
  return `${env.CDN_BASE_URL.replace(/\/$/, '')}/${key.replace(/\.[^./]+$/, '_card.webp')}`;
}

/**
 * A followed product, as the buyer's list needs it.
 *
 * `unavailableReason` is carried rather than inferred from the flags because a client that has
 * to guess will guess wrong: "the seller is closed today" and "this is sold out" produce the
 * same greyed-out card otherwise, and only one of them is worth waiting for.
 */
function toProductResponse(item: FavouriteProductItem, locale: Locale) {
  const { favourite, product, purchasable } = item;
  return {
    id: favourite.id,
    productId: favourite.targetId,
    shopId: favourite.shopId,
    name: product ? localized(product.name, locale) : null,
    slug: product?.slug ?? null,
    image: cardImage(product?.images[0]?.mediaKey),
    price: product ? product.price.toStorage() : null,
    priceWatermark:
      favourite.state.priceWatermarkMinor === null
        ? null
        : favourite.state.priceWatermarkMinor.toString(),
    unit: product?.unit ?? null,
    isVisible: product?.isVisible ?? false,
    isPurchasable: purchasable,
    unavailableReason: product
      ? product.isVisible
        ? purchasable
          ? null
          : 'OUT_OF_STOCK'
        : product.visibilityReason
      : 'WITHDRAWN',
    alertsEnabled: favourite.alertsEnabled,
    createdAt: favourite.createdAt.toISOString(),
  };
}

function toShopResponse(item: FavouriteShopItem, locale: Locale) {
  const { favourite, shop } = item;
  return {
    id: favourite.id,
    shopId: favourite.targetId,
    name: shop ? localized(shop.name, locale) : null,
    slug: shop?.slug ?? null,
    marketId: shop?.marketId ?? null,
    isVisible: shop?.isVisible ?? false,
    createdAt: favourite.createdAt.toISOString(),
  };
}

export function createFavouriteController(favourites: FavouriteService) {
  return {
    add: async (req: Request, res: Response): Promise<void> => {
      const actor = requireAuth(req);
      const body = req.body as { targetType: FavouriteTarget; targetId: string };
      const record = await favourites.add(actor.userId, body);
      sendCreated(res, { id: record.id, targetType: record.targetType, targetId: record.targetId });
    },

    remove: async (req: Request, res: Response): Promise<void> => {
      const actor = requireAuth(req);
      await favourites.remove(
        actor.userId,
        parseTargetType(req.params.targetType),
        requireParam(req.params.targetId, 'Favourite'),
      );
      sendNoContent(res);
    },

    listProducts: async (req: Request, res: Response): Promise<void> => {
      const actor = requireAuth(req);
      const query = req.validatedQuery as { limit: number; cursor?: string };
      const page = await favourites.listProducts(actor.userId, {
        limit: query.limit,
        cursor: query.cursor ?? null,
      });
      sendCollection(
        res,
        page.items.map((item) => toProductResponse(item, req.locale)),
        { next: page.nextCursor, hasMore: page.nextCursor !== null },
      );
    },

    listShops: async (req: Request, res: Response): Promise<void> => {
      const actor = requireAuth(req);
      const query = req.validatedQuery as { limit: number; cursor?: string };
      const page = await favourites.listShops(actor.userId, {
        limit: query.limit,
        cursor: query.cursor ?? null,
      });
      sendCollection(
        res,
        page.items.map((item) => toShopResponse(item, req.locale)),
        { next: page.nextCursor, hasMore: page.nextCursor !== null },
      );
    },

    status: async (req: Request, res: Response): Promise<void> => {
      const actor = requireAuth(req);
      const query = req.validatedQuery as { targetType: FavouriteTarget; ids: string[] };
      const followed = await favourites.status(actor.userId, query.targetType, query.ids);
      sendData(res, { followed });
    },

    setAlerts: async (req: Request, res: Response): Promise<void> => {
      const actor = requireAuth(req);
      const body = req.body as { alertsEnabled: boolean };
      const record = await favourites.setAlerts(
        actor.userId,
        requireParam(req.params.productId, 'Favourite'),
        body.alertsEnabled,
      );
      sendData(res, { id: record.id, alertsEnabled: record.alertsEnabled });
    },

    sellerCounts: async (req: Request, res: Response): Promise<void> => {
      const actor = requireAuth(req);
      const counts = await favourites.followerCounts(
        requireParam(req.params.id, 'Product'),
        actor.shopIds,
      );
      sendData(res, counts);
    },
  };
}

export type FavouriteController = ReturnType<typeof createFavouriteController>;
