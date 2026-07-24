import { Types, type ClientSession } from 'mongoose';
import type { LocalizedText, MarketStatus, WorkingHoursEntry } from '@bozorlar/types';
import { MarketModel, type MarketDoc, type MediaRef } from '../models/market.model.js';
import type { ParsedQuery } from '../../../http/query.js';

export interface MarketRecord {
  id: string;
  districtId: string;
  regionId: string;
  name: LocalizedText;
  slug: string;
  description: LocalizedText | null;
  location: { lat: number; lng: number };
  address: LocalizedText;
  photos: MediaRef[];
  workingHours: WorkingHoursEntry[];
  timezone: string;
  contactPhone: string | null;
  status: MarketStatus;
  shopCount: number;
  productCount: number;
  sections: Array<{ code: string; name: LocalizedText }>;
  createdAt: Date;
  /** Present only on nearby queries. */
  distanceMeters?: number;
}

function toRecord(doc: MarketDoc & { distanceMeters?: number }): MarketRecord {
  const [lng = 0, lat = 0] = doc.location.coordinates;
  return {
    id: doc._id.toString(),
    districtId: doc.districtId.toString(),
    regionId: doc.regionId.toString(),
    name: doc.name,
    slug: doc.slug,
    description: doc.description,
    location: { lat, lng },
    address: doc.address,
    photos: doc.photos,
    workingHours: doc.workingHours,
    timezone: doc.timezone,
    contactPhone: doc.contactPhone,
    status: doc.status,
    shopCount: doc.shopCount,
    productCount: doc.productCount,
    sections: doc.sections,
    createdAt: doc.createdAt,
    ...(doc.distanceMeters !== undefined ? { distanceMeters: Math.round(doc.distanceMeters) } : {}),
  };
}

export const marketRepository = {
  /** Fetches limit + 1 rows so `hasMore` needs no count query. */
  async list(parsed: ParsedQuery): Promise<MarketRecord[]> {
    const filter = parsed.cursorFilter
      ? { $and: [parsed.filter, parsed.cursorFilter] }
      : parsed.filter;
    const docs = await MarketModel.find(filter)
      .sort(parsed.sort)
      .limit(parsed.limit + 1)
      .lean<MarketDoc[]>();
    return docs.map(toRecord);
  },

  async findByIdOrSlug(idOrSlug: string): Promise<MarketRecord | null> {
    const filter = Types.ObjectId.isValid(idOrSlug)
      ? { _id: idOrSlug }
      : { slug: idOrSlug.toLowerCase() };
    const doc = await MarketModel.findOne(filter).lean<MarketDoc>();
    return doc ? toRecord(doc) : null;
  },

  async findManyByIds(ids: readonly string[]): Promise<Map<string, MarketRecord>> {
    if (ids.length === 0) return new Map();
    const docs = await MarketModel.find({ _id: { $in: ids } }).lean<MarketDoc[]>();
    return new Map(docs.map((doc) => [doc._id.toString(), toRecord(doc)]));
  },

  /**
   * $geoNear must be the first pipeline stage and uses the 2dsphere index directly, so this
   * stays a targeted query rather than a scan with a distance filter applied afterwards.
   */
  async findNearby(input: {
    lat: number;
    lng: number;
    radiusMeters: number;
    limit: number;
    status: MarketStatus;
  }): Promise<MarketRecord[]> {
    const docs = await MarketModel.aggregate<MarketDoc & { distanceMeters: number }>([
      {
        $geoNear: {
          near: { type: 'Point', coordinates: [input.lng, input.lat] },
          distanceField: 'distanceMeters',
          maxDistance: input.radiusMeters,
          spherical: true,
          query: { status: input.status },
        },
      },
      { $limit: input.limit },
    ]);
    return docs.map(toRecord);
  },

  async slugExists(slug: string): Promise<boolean> {
    return (await MarketModel.countDocuments({ slug }).limit(1)) > 0;
  },

  async incrementShopCount(marketId: string, delta: number, session?: ClientSession): Promise<void> {
    await MarketModel.updateOne(
      { _id: marketId },
      { $inc: { shopCount: delta } },
      session ? { session } : {},
    );
  },
};
