import { resolveLocalized, type Locale, type LocalizedText } from '@bozorlar/types';
import type { DistrictRecord, RegionRecord } from '../repositories/geo.repository.js';
import type { MarketView } from '../services/geo.service.js';
import type { ShopView } from '../services/shop.service.js';

/**
 * Response serialization.
 *
 * Localized text is resolved against Accept-Language by default; editing surfaces pass
 * `raw=true` to receive the full object (API.md 1.10). Fields marked ● in the API spec are
 * emitted only for the shop's own members or an administrator, and that decision is made
 * here rather than in each endpoint, so a new sensitive field is protected everywhere at
 * once (API.md 8.3).
 */
export interface ViewOptions {
  locale: Locale;
  raw: boolean;
}

function text(value: LocalizedText | null, options: ViewOptions): string | LocalizedText | null {
  if (value === null) return null;
  return options.raw ? value : resolveLocalized(value, options.locale);
}

export function toRegionResponse(region: RegionRecord, options: ViewOptions) {
  return {
    id: region.id,
    code: region.code,
    name: text(region.name, options),
    center: region.center,
    districtCount: region.districtCount,
  };
}

export function toDistrictResponse(district: DistrictRecord, options: ViewOptions) {
  return {
    id: district.id,
    regionId: district.regionId,
    code: district.code,
    name: text(district.name, options),
    center: district.center,
    isCity: district.isCity,
    marketCount: district.marketCount,
  };
}

export function toMarketResponse(market: MarketView, options: ViewOptions) {
  return {
    id: market.id,
    slug: market.slug,
    name: text(market.name, options),
    description: text(market.description, options),
    address: text(market.address, options),
    districtId: market.districtId,
    regionId: market.regionId,
    location: market.location,
    ...(market.distanceMeters !== undefined ? { distanceMeters: market.distanceMeters } : {}),
    photos: market.photos.map((photo) => ({ key: photo.key, blurhash: photo.blurhash })),
    workingHours: market.workingHours,
    timezone: market.timezone,
    isOpenNow: market.isOpenNow,
    opensNextAt: market.opensNextAt,
    closesAt: market.closesAt,
    contactPhone: market.contactPhone,
    status: market.status,
    shopCount: market.shopCount,
    productCount: market.productCount,
    sections: market.sections.map((section) => ({
      code: section.code,
      name: text(section.name, options),
    })),
  };
}

export interface ShopViewerContext extends ViewOptions {
  /** True for shop members and administrators. Gates the ● fields. */
  privileged: boolean;
}

export function toShopResponse(shop: ShopView, options: ShopViewerContext) {
  return {
    id: shop.id,
    slug: shop.slug,
    name: text(shop.name, options),
    description: text(shop.description, options),
    marketId: shop.marketId,
    districtId: shop.districtId,
    regionId: shop.regionId,
    logo: shop.logo ? { key: shop.logo.key, blurhash: shop.logo.blurhash } : null,
    cover: shop.cover ? { key: shop.cover.key, blurhash: shop.cover.blurhash } : null,
    sectionCode: shop.sectionCode,
    stallNo: shop.stallNo,
    contactPhone: shop.contactPhone,
    workingHours: shop.workingHours,
    timezone: shop.timezone,
    isOpenNow: shop.isOpenNow,
    opensNextAt: shop.opensNextAt,
    categoryIds: shop.categoryIds,
    rating: { avg: shop.ratingAvg / 100, count: shop.ratingCount },
    productCount: shop.productCount,
    salesCount: shop.salesCount,
    isVisible: shop.isVisible,
    createdAt: shop.createdAt.toISOString(),
    ...(options.privileged
      ? {
          ownerId: shop.ownerId,
          status: shop.status,
          moderationStatus: shop.moderationStatus,
          moderationReason: shop.moderationReason,
          visibilityReason: shop.visibilityReason,
          reliabilityScore: shop.reliabilityScore,
          vacationUntil: shop.vacationUntil?.toISOString() ?? null,
          members: shop.members.map((member) => ({
            userId: member.userId,
            role: member.role,
            addedAt: member.addedAt.toISOString(),
          })),
        }
      : {}),
  };
}
