import { Types } from 'mongoose';
import type { Logger } from '@bozorlar/logger';
import { RegionModel } from '../modules/geo/models/region.model.js';
import { DistrictModel } from '../modules/geo/models/district.model.js';
import { SEED_REGIONS, SEED_DISTRICT_COUNT, SEED_REGION_COUNT } from './regions.data.js';

export interface SeedResult {
  regionsInserted: number;
  regionsUpdated: number;
  districtsInserted: number;
  districtsUpdated: number;
}

/**
 * Idempotent geography seeder.
 *
 * Re-running must be safe: administrative divisions are periodically renamed or split, and
 * an operator will run this again after such a change. Records are matched on their stable
 * `code`, so names are corrected in place and markets already attached to a district keep
 * pointing at the same document.
 *
 * Nothing is deleted. A district that disappears from the classifier is left in place and
 * deactivated by hand, because removing it would orphan every market inside it.
 */
export async function seedGeography(logger: Logger): Promise<SeedResult> {
  const result: SeedResult = {
    regionsInserted: 0,
    regionsUpdated: 0,
    districtsInserted: 0,
    districtsUpdated: 0,
  };

  for (const [regionIndex, region] of SEED_REGIONS.entries()) {
    const existing = await RegionModel.findOne({ code: region.code }, { _id: 1 }).lean<{
      _id: Types.ObjectId;
    }>();

    const regionUpdate = {
      name: { uz: region.uz, uzCyrl: region.uzCyrl, ru: region.ru, en: region.en },
      center: { type: 'Point' as const, coordinates: [region.center.lng, region.center.lat] },
      order: regionIndex,
      isActive: true,
      districtCount: region.districts.length,
    };

    const regionDoc = await RegionModel.findOneAndUpdate(
      { code: region.code },
      { $set: regionUpdate, $setOnInsert: { code: region.code, schemaVersion: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean<{ _id: Types.ObjectId }>();

    if (existing) result.regionsUpdated += 1;
    else result.regionsInserted += 1;

    for (const [districtIndex, district] of region.districts.entries()) {
      const existingDistrict = await DistrictModel.findOne(
        { code: district.code },
        { _id: 1 },
      ).lean<{ _id: Types.ObjectId }>();

      await DistrictModel.updateOne(
        { code: district.code },
        {
          $set: {
            regionId: regionDoc._id,
            name: { uz: district.uz, ru: district.ru, en: district.en },
            isCity: district.isCity ?? false,
            order: districtIndex,
            isActive: true,
            ...(district.center
              ? {
                  center: {
                    type: 'Point' as const,
                    coordinates: [district.center.lng, district.center.lat],
                  },
                }
              : {}),
          },
          $setOnInsert: { code: district.code, schemaVersion: 1 },
        },
        { upsert: true, setDefaultsOnInsert: true },
      );

      if (existingDistrict) result.districtsUpdated += 1;
      else result.districtsInserted += 1;
    }
  }

  logger.info(
    { ...result, expectedRegions: SEED_REGION_COUNT, expectedDistricts: SEED_DISTRICT_COUNT },
    'geography seed complete',
  );
  return result;
}
