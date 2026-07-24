import { Types } from 'mongoose';
import type { LocalizedText } from '@bozorlar/types';
import { RegionModel, type RegionDoc } from '../models/region.model.js';
import { DistrictModel, type DistrictDoc } from '../models/district.model.js';

export interface RegionRecord {
  id: string;
  code: string;
  name: LocalizedText;
  center: { lat: number; lng: number };
  order: number;
  districtCount: number;
}

export interface DistrictRecord {
  id: string;
  regionId: string;
  code: string;
  name: LocalizedText;
  center: { lat: number; lng: number } | null;
  isCity: boolean;
  marketCount: number;
}

function toRegion(doc: RegionDoc): RegionRecord {
  const [lng = 0, lat = 0] = doc.center.coordinates;
  return {
    id: doc._id.toString(),
    code: doc.code,
    name: doc.name,
    center: { lat, lng },
    order: doc.order,
    districtCount: doc.districtCount,
  };
}

function toDistrict(doc: DistrictDoc): DistrictRecord {
  const coordinates = doc.center?.coordinates;
  return {
    id: doc._id.toString(),
    regionId: doc.regionId.toString(),
    code: doc.code,
    name: doc.name,
    center: coordinates ? { lat: coordinates[1] ?? 0, lng: coordinates[0] ?? 0 } : null,
    isCity: doc.isCity,
    marketCount: doc.marketCount,
  };
}

export const geoRepository = {
  async listRegions(): Promise<RegionRecord[]> {
    const docs = await RegionModel.find({ isActive: true }).sort({ order: 1 }).lean<RegionDoc[]>();
    return docs.map(toRegion);
  },

  async findRegion(idOrCode: string): Promise<RegionRecord | null> {
    const filter = Types.ObjectId.isValid(idOrCode)
      ? { _id: idOrCode }
      : { code: idOrCode.toUpperCase() };
    const doc = await RegionModel.findOne(filter).lean<RegionDoc>();
    return doc ? toRegion(doc) : null;
  },

  async listDistricts(regionId: string): Promise<DistrictRecord[]> {
    const docs = await DistrictModel.find({ regionId, isActive: true })
      .sort({ order: 1 })
      .lean<DistrictDoc[]>();
    return docs.map(toDistrict);
  },

  async findDistrict(idOrCode: string): Promise<DistrictRecord | null> {
    const filter = Types.ObjectId.isValid(idOrCode)
      ? { _id: idOrCode }
      : { code: idOrCode.toUpperCase() };
    const doc = await DistrictModel.findOne(filter).lean<DistrictDoc>();
    return doc ? toDistrict(doc) : null;
  },

  async incrementMarketCount(districtId: string, delta: number): Promise<void> {
    await DistrictModel.updateOne({ _id: districtId }, { $inc: { marketCount: delta } });
  },
};
