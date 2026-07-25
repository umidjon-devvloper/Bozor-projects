import type { Request, Response } from 'express';
import { AppError, ErrorCode } from '@bozorlar/errors';
import { sendCollection, sendCreated, sendData, sendNoContent } from '../../../http/envelope.js';
import type { GeoService } from '../services/geo.service.js';
import type { MarketService } from '../services/market.service.js';
import type { ShopService } from '../services/shop.service.js';
import {
  toDistrictResponse,
  toMarketResponse,
  toRegionResponse,
  toShopResponse,
  type ShopViewerContext,
  type ViewOptions,
} from './mappers.js';

function viewOptions(req: Request): ViewOptions {
  return { locale: req.locale, raw: req.query.raw === 'true' };
}

function shopViewer(req: Request, shopId: string | null): ShopViewerContext {
  const auth = req.auth;
  const privileged = Boolean(
    auth &&
      ((shopId !== null && auth.shopIds.includes(shopId)) ||
        auth.permissions.has('geo:shop:moderate')),
  );
  return { ...viewOptions(req), privileged };
}

function requireAuth(req: Request) {
  if (!req.auth) throw new AppError(ErrorCode.AUTH_REQUIRED);
  return req.auth;
}

function requireParam(value: string | undefined, name: string): string {
  if (!value) throw new AppError(ErrorCode.RESOURCE_NOT_FOUND, { detail: `${name} not found` });
  return value;
}

export function createGeoController(deps: {
  geo: GeoService;
  markets: MarketService;
  shops: ShopService;
}) {
  const { geo, markets, shops } = deps;

  return {
    // ---- public geography ----
    async listRegions(req: Request, res: Response): Promise<void> {
      const options = viewOptions(req);
      const regions = await geo.listRegions();
      // Reference data is immutable in practice, so a strong ETag lets clients skip the
      // payload entirely on repeat visits.
      res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
      sendData(res, regions.map((region) => toRegionResponse(region, options)));
    },

    async listDistricts(req: Request, res: Response): Promise<void> {
      const options = viewOptions(req);
      const districts = await geo.listDistricts(requireParam(req.params.id, 'Region'));
      res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
      sendData(res, districts.map((district) => toDistrictResponse(district, options)));
    },

    // ---- public markets ----
    async listMarkets(req: Request, res: Response): Promise<void> {
      const options = viewOptions(req);
      const page = await geo.listMarkets(req.query);
      res.setHeader('Cache-Control', 'public, max-age=900, stale-while-revalidate=3600');
      sendCollection(
        res,
        page.items.map((market) => toMarketResponse(market, options)),
        { next: page.nextCursor, hasMore: page.hasMore },
      );
    },

    async nearbyMarkets(req: Request, res: Response): Promise<void> {
      const options = viewOptions(req);
      const query = req.validatedQuery as { lat: number; lng: number; radius: number; limit: number };
      const found = await geo.findNearbyMarkets({
        lat: query.lat,
        lng: query.lng,
        radiusMeters: query.radius,
        limit: query.limit,
      });
      // Location-dependent and therefore never shared between users.
      res.setHeader('Cache-Control', 'private, max-age=300');
      sendData(res, found.map((market) => toMarketResponse(market, options)));
    },

    async getMarket(req: Request, res: Response): Promise<void> {
      const options = viewOptions(req);
      const market = await geo.getMarket(requireParam(req.params.idOrSlug, 'Market'));
      res.setHeader('Cache-Control', 'public, max-age=900, stale-while-revalidate=3600');
      sendData(res, toMarketResponse(market, options));
    },

    async listMarketShops(req: Request, res: Response): Promise<void> {
      const marketId = requireParam(req.params.id, 'Market');
      const page = await shops.listPublic({ ...(req.query as Record<string, unknown>), marketId });
      sendCollection(
        res,
        page.items.map((shop) => toShopResponse(shop, shopViewer(req, shop.id))),
        { next: page.nextCursor, hasMore: page.hasMore },
      );
    },

    // ---- public shops ----
    async listShops(req: Request, res: Response): Promise<void> {
      const page = await shops.listPublic(req.query);
      sendCollection(
        res,
        page.items.map((shop) => toShopResponse(shop, shopViewer(req, shop.id))),
        { next: page.nextCursor, hasMore: page.hasMore },
      );
    },

    async getShop(req: Request, res: Response): Promise<void> {
      const shop = await shops.getPublic(requireParam(req.params.idOrSlug, 'Shop'));
      sendData(res, toShopResponse(shop, shopViewer(req, shop.id)));
    },

    // ---- seller shop management ----
    async listMyShops(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      const owned = await shops.listForUser(auth.userId);
      sendData(
        res,
        owned.map((shop) => toShopResponse(shop, { ...viewOptions(req), privileged: true })),
      );
    },

    async createShop(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      const body = req.body as Parameters<ShopService['create']>[0];
      const shop = await shops.create({ ...body, ownerId: auth.userId });
      sendCreated(res, toShopResponse(shop, { ...viewOptions(req), privileged: true }), `/api/v1/shops/${shop.id}`);
    },

    async getMyShop(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      const shop = await shops.getForMember(requireParam(req.params.id, 'Shop'), auth.shopIds);
      sendData(res, toShopResponse(shop, { ...viewOptions(req), privileged: true }));
    },

    async updateShop(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      const shop = await shops.update(
        requireParam(req.params.id, 'Shop'),
        { userId: auth.userId, shopIds: auth.shopIds },
        req.body as Record<string, never>,
      );
      sendData(res, toShopResponse(shop, { ...viewOptions(req), privileged: true }));
    },

    async setWorkingHours(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      const body = req.body as { workingHours: never[]; timezone?: string };
      const shop = await shops.setWorkingHours(
        requireParam(req.params.id, 'Shop'),
        { userId: auth.userId, shopIds: auth.shopIds },
        body.workingHours,
        body.timezone,
      );
      sendData(res, toShopResponse(shop, { ...viewOptions(req), privileged: true }));
    },

    async setVacation(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      const { until } = req.body as { until: string | null };
      const shop = await shops.setVacation(
        requireParam(req.params.id, 'Shop'),
        { userId: auth.userId, shopIds: auth.shopIds },
        until === null ? null : new Date(until),
      );
      sendData(res, toShopResponse(shop, { ...viewOptions(req), privileged: true }));
    },

    async addMember(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      const shop = await shops.addMember(
        requireParam(req.params.id, 'Shop'),
        { userId: auth.userId, shopIds: auth.shopIds },
        req.body as { phone: string; role: never },
      );
      sendCreated(res, toShopResponse(shop, { ...viewOptions(req), privileged: true }));
    },

    async removeMember(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      await shops.removeMember(
        requireParam(req.params.id, 'Shop'),
        { userId: auth.userId, shopIds: auth.shopIds },
        requireParam(req.params.userId, 'Member'),
      );
      sendNoContent(res);
    },

    async closeShop(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      await shops.close(requireParam(req.params.id, 'Shop'), {
        userId: auth.userId,
        shopIds: auth.shopIds,
      });
      sendNoContent(res);
    },

    // ---- admin ----
    async createMarket(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      const market = await markets.create(
        req.body as Parameters<MarketService['create']>[0],
        auth.userId,
      );
      const view = await geo.getMarket(market.id);
      sendCreated(res, toMarketResponse(view, viewOptions(req)), `/api/v1/markets/${market.id}`);
    },

    async updateMarket(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      await markets.update(
        requireParam(req.params.id, 'Market'),
        auth.userId,
        req.body as Record<string, never>,
      );
      const view = await geo.getMarket(requireParam(req.params.id, 'Market'));
      sendData(res, toMarketResponse(view, viewOptions(req)));
    },

    async setMarketStatus(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      const { status, reason } = req.body as { status: never; reason: string };
      const result = await markets.setStatus(
        requireParam(req.params.id, 'Market'),
        auth.userId,
        status,
        reason,
      );
      const view = await geo.getMarket(result.market.id);
      sendData(res, {
        market: toMarketResponse(view, viewOptions(req)),
        shopsAffected: result.shopsAffected,
      });
    },

    async shopModerationQueue(req: Request, res: Response): Promise<void> {
      const page = await shops.listForModeration(req.query as Record<string, unknown>);
      sendCollection(
        res,
        page.items.map((shop) => toShopResponse(shop, { ...viewOptions(req), privileged: true })),
        {
          next: page.nextCursor,
          hasMore: page.hasMore,
        },
      );
    },

    async moderateShop(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      const body = req.body as { approved: boolean; reason?: string };
      const shop = await shops.moderate(requireParam(req.params.id, 'Shop'), auth.userId, body);
      sendData(res, toShopResponse(shop, { ...viewOptions(req), privileged: true }));
    },
  };
}

export type GeoController = ReturnType<typeof createGeoController>;
