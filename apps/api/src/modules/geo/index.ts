/**
 * Public surface of the geo module. Nothing outside may import its internals
 * (ADR-0011 rule 1), enforced by dependency-cruiser in CI.
 */
export { createGeoService, type GeoService, type MarketView } from './services/geo.service.js';
export { createMarketService, type MarketService } from './services/market.service.js';
export { createShopService, type ShopService, type ShopView } from './services/shop.service.js';
// Re-exported from @bozorlar/domain so callers inside this app keep importing through the
// module's public surface (ADR-0011 rule 1) while the rule itself stays shared.
export {
  computeShopVisibility,
  VisibilityReason,
  type VisibilityInputs,
  type VisibilityResult,
} from '@bozorlar/domain';
export {
  evaluateOpening,
  assertValidWorkingHours,
  isValidTimezone,
  parseTimeToMinutes,
  type OpeningState,
} from './services/workingHours.service.js';
export { slugify, generateUniqueSlug } from './services/slug.js';
export { createGeoController, type GeoController } from './http/geo.controller.js';
export {
  createGeoRouter,
  createSellerShopRouter,
  createGeoAdminRouter,
} from './http/geo.routes.js';
export { GeoEvents } from './events.js';
