import { MarketStatus, ModerationStatus, ShopStatus } from '@bozorlar/types';

/**
 * THE shop visibility rule.
 *
 * This function exists exactly once, in a shared package, because more than one deployable
 * needs it: the API recomputes on every write, and the worker recomputes when a vacation
 * expires. Reimplementing the rule anywhere else — including as a hand-written Mongo filter —
 * is a review-blocking defect, because divergent copies are precisely how a deactivated
 * seller stays visible on one surface and not another (MARKET_SYSTEM.md).
 *
 * It is pure: no I/O, no clock, no database. Every input is passed in, which is what makes it
 * exhaustively testable and safe to call from a hot path.
 */
export interface VisibilityInputs {
  shopStatus: ShopStatus;
  moderationStatus: ModerationStatus;
  marketStatus: MarketStatus;
  /**
   * Owned by the wallet module (Phase 6), denormalized onto the shop and maintained by the
   * `seller.deactivated` / `seller.activated` handlers. Until that module lands, shops are
   * created with `true` and nothing mutates it — the field is real, its writer arrives later.
   */
  sellerWalletActive: boolean;
  vacationUntil: Date | null;
  now: Date;
}

export const VisibilityReason = {
  VISIBLE: 'VISIBLE',
  SHOP_NOT_ACTIVE: 'SHOP_NOT_ACTIVE',
  MODERATION_NOT_APPROVED: 'MODERATION_NOT_APPROVED',
  MARKET_NOT_ACTIVE: 'MARKET_NOT_ACTIVE',
  SELLER_WALLET_INACTIVE: 'SELLER_WALLET_INACTIVE',
  ON_VACATION: 'ON_VACATION',
} as const;
export type VisibilityReason = (typeof VisibilityReason)[keyof typeof VisibilityReason];

export interface VisibilityResult {
  isVisible: boolean;
  reason: VisibilityReason;
}

export function computeShopVisibility(inputs: VisibilityInputs): VisibilityResult {
  if (inputs.shopStatus !== ShopStatus.ACTIVE) {
    return { isVisible: false, reason: VisibilityReason.SHOP_NOT_ACTIVE };
  }
  if (inputs.moderationStatus !== ModerationStatus.APPROVED) {
    return { isVisible: false, reason: VisibilityReason.MODERATION_NOT_APPROVED };
  }
  if (inputs.marketStatus !== MarketStatus.ACTIVE) {
    return { isVisible: false, reason: VisibilityReason.MARKET_NOT_ACTIVE };
  }
  if (!inputs.sellerWalletActive) {
    return { isVisible: false, reason: VisibilityReason.SELLER_WALLET_INACTIVE };
  }
  if (inputs.vacationUntil !== null && inputs.vacationUntil.getTime() > inputs.now.getTime()) {
    return { isVisible: false, reason: VisibilityReason.ON_VACATION };
  }
  return { isVisible: true, reason: VisibilityReason.VISIBLE };
}

/**
 * Working hours deliberately do NOT gate visibility.
 *
 * A bazaar seller may fulfil an order placed before opening, so hiding the shop overnight
 * would cost real orders. Instead `isOpenNow` and `opensNextAt` are surfaced on the response
 * and the order flow flags the next opening window (MARKET_SYSTEM.md "Working hours").
 */
