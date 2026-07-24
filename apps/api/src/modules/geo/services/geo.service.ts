import { AppError, ErrorCode, notFound } from '@bozorlar/errors';
import { MarketStatus } from '@bozorlar/types';
import { CacheTag, type Cache } from '../../../shared/cache.js';
import { geoRepository, type DistrictRecord, type RegionRecord } from '../repositories/geo.repository.js';
import { marketRepository, type MarketRecord } from '../repositories/market.repository.js';
import { parseQuery, toPage, type Page, type QuerySpec } from '../../../http/query.js';
import { evaluateOpening } from './workingHours.service.js';

/** Every filter and sort below is backed by an index in DATABASE.md Part 5. */
export const MARKET_QUERY_SPEC: QuerySpec = {
  filters: [
    { field: 'regionId', type: 'objectId', operators: ['eq', 'in'] },
    { field: 'districtId', type: 'objectId', operators: ['eq', 'in'] },
    { field: 'status', type: 'string', operators: ['eq', 'in'] },
  ],
  sorts: [
    { key: '-shopCount', sort: { shopCount: -1, _id: -1 } },
    { key: '-createdAt', sort: { createdAt: -1, _id: -1 } },
    { key: 'createdAt', sort: { createdAt: 1, _id: 1 } },
  ],
  defaultSort: '-shopCount',
};

const REGION_TTL = 24 * 60 * 60;
const DISTRICT_TTL = 24 * 60 * 60;
const MARKET_TTL = 15 * 60;

export interface MarketView extends MarketRecord {
  isOpenNow: boolean;
  opensNextAt: string | null;
  closesAt: string | null;
}

export function createGeoService(cache: Cache) {
  function withOpeningState(market: MarketRecord, now: Date): MarketView {
    const opening = evaluateOpening(market.workingHours, market.timezone, now);
    return {
      ...market,
      isOpenNow: opening.isOpenNow,
      opensNextAt: opening.opensNextAt?.toISOString() ?? null,
      closesAt: opening.closesAt?.toISOString() ?? null,
    };
  }

  return {
    async listRegions(): Promise<RegionRecord[]> {
      return cache.readThrough(
        'regions',
        { ttlSeconds: REGION_TTL, tags: [CacheTag.regions()] },
        () => geoRepository.listRegions(),
      );
    },

    async getRegion(idOrCode: string): Promise<RegionRecord> {
      const region = await geoRepository.findRegion(idOrCode);
      if (!region) throw notFound('Region');
      return region;
    },

    async listDistricts(regionIdOrCode: string): Promise<DistrictRecord[]> {
      const region = await geoRepository.findRegion(regionIdOrCode);
      if (!region) throw notFound('Region');
      return cache.readThrough(
        `districts:${region.id}`,
        { ttlSeconds: DISTRICT_TTL, tags: [CacheTag.districts(region.id)] },
        () => geoRepository.listDistricts(region.id),
      );
    },

    async listMarkets(query: Record<string, unknown>): Promise<Page<MarketView>> {
      const parsed = parseQuery(query, MARKET_QUERY_SPEC);
      const rows = await marketRepository.list(parsed);
      const page = toPage(rows as unknown as Record<string, unknown>[], parsed);
      const now = new Date();
      return {
        items: (page.items as unknown as MarketRecord[]).map((market) =>
          withOpeningState(market, now),
        ),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      };
    },

    async getMarket(idOrSlug: string): Promise<MarketView> {
      const market = await cache.readThrough(
        `market:${idOrSlug}`,
        { ttlSeconds: MARKET_TTL, tags: [CacheTag.marketList()] },
        () => marketRepository.findByIdOrSlug(idOrSlug),
      );
      if (!market) throw notFound('Market');
      // Dates survive JSON round-tripping as strings; restore them before use.
      const restored: MarketRecord = { ...market, createdAt: new Date(market.createdAt) };
      return withOpeningState(restored, new Date());
    },

    /**
     * Radius is capped server-side. An uncapped radius turns a targeted 2dsphere lookup into
     * a full-collection distance sort, which is exactly the query nobody notices until the
     * collection is large.
     */
    async findNearbyMarkets(input: {
      lat: number;
      lng: number;
      radiusMeters: number;
      limit: number;
    }): Promise<MarketView[]> {
      if (input.lat < -90 || input.lat > 90 || input.lng < -180 || input.lng > 180) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, {
          detail: 'Coordinates are out of range',
          errors: [{ field: 'lat', code: 'OUT_OF_RANGE' }],
        });
      }
      const markets = await marketRepository.findNearby({
        lat: input.lat,
        lng: input.lng,
        radiusMeters: Math.min(input.radiusMeters, 50_000),
        limit: Math.min(input.limit, 50),
        status: MarketStatus.ACTIVE,
      });
      const now = new Date();
      return markets.map((market) => withOpeningState(market, now));
    },
  };
}

export type GeoService = ReturnType<typeof createGeoService>;
