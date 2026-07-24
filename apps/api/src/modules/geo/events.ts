/** Geo domain events (EVENTS.md). */
export const GeoEvents = {
  MARKET_CREATED: 'market.created',
  MARKET_UPDATED: 'market.updated',
  MARKET_STATUS_CHANGED: 'market.status_changed',
  SHOP_CREATED: 'shop.created',
  SHOP_UPDATED: 'shop.updated',
  SHOP_VISIBILITY_CHANGED: 'shop.visibility_changed',
  SHOP_MEMBER_ADDED: 'shop.member_added',
  SHOP_MEMBER_REMOVED: 'shop.member_removed',
  SHOP_MODERATION_DECIDED: 'shop.moderation_decided',
} as const;

export type GeoEvent = (typeof GeoEvents)[keyof typeof GeoEvents];
