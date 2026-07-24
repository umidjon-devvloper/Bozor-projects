import { describe, expect, it } from 'vitest';
import { MarketStatus, ModerationStatus, ShopStatus } from '@bozorlar/types';
import { computeShopVisibility, VisibilityReason } from '@bozorlar/domain';

const NOW = new Date('2026-07-23T12:00:00Z');

const visibleInputs = {
  shopStatus: ShopStatus.ACTIVE,
  moderationStatus: ModerationStatus.APPROVED,
  marketStatus: MarketStatus.ACTIVE,
  sellerWalletActive: true,
  vacationUntil: null,
  now: NOW,
};

describe('computeShopVisibility', () => {
  it('is visible only when every condition holds', () => {
    expect(computeShopVisibility(visibleInputs)).toEqual({
      isVisible: true,
      reason: VisibilityReason.VISIBLE,
    });
  });

  it('hides a shop that is not active', () => {
    for (const status of [ShopStatus.DRAFT, ShopStatus.SUSPENDED, ShopStatus.CLOSED]) {
      expect(computeShopVisibility({ ...visibleInputs, shopStatus: status })).toEqual({
        isVisible: false,
        reason: VisibilityReason.SHOP_NOT_ACTIVE,
      });
    }
  });

  it('hides a shop awaiting or refused moderation', () => {
    for (const status of [ModerationStatus.PENDING, ModerationStatus.REJECTED]) {
      expect(computeShopVisibility({ ...visibleInputs, moderationStatus: status }).isVisible).toBe(false);
    }
  });

  it('hides every shop in a market that is not active', () => {
    expect(computeShopVisibility({ ...visibleInputs, marketStatus: MarketStatus.TEMPORARILY_CLOSED })).toEqual({
      isVisible: false,
      reason: VisibilityReason.MARKET_NOT_ACTIVE,
    });
  });

  it('hides a shop whose seller wallet is depleted', () => {
    // The commercial rule that makes the platform work: an unpaid seller disappears from
    // every surface at once (WALLET_SYSTEM.md).
    expect(computeShopVisibility({ ...visibleInputs, sellerWalletActive: false })).toEqual({
      isVisible: false,
      reason: VisibilityReason.SELLER_WALLET_INACTIVE,
    });
  });

  it('hides a shop on vacation, and shows it once the vacation has passed', () => {
    const future = new Date(NOW.getTime() + 86_400_000);
    const past = new Date(NOW.getTime() - 86_400_000);
    expect(computeShopVisibility({ ...visibleInputs, vacationUntil: future }).isVisible).toBe(false);
    expect(computeShopVisibility({ ...visibleInputs, vacationUntil: past }).isVisible).toBe(true);
  });

  it('reports the first failing condition, in a stable order', () => {
    // Determinism matters: the reason is stored on the shop and surfaced to the seller, so
    // it must not flip between equally-true causes.
    const result = computeShopVisibility({
      ...visibleInputs,
      shopStatus: ShopStatus.SUSPENDED,
      moderationStatus: ModerationStatus.REJECTED,
      marketStatus: MarketStatus.ARCHIVED,
      sellerWalletActive: false,
    });
    expect(result.reason).toBe(VisibilityReason.SHOP_NOT_ACTIVE);
  });

  it('is pure — the same inputs always give the same answer', () => {
    const first = computeShopVisibility(visibleInputs);
    const second = computeShopVisibility(visibleInputs);
    expect(first).toEqual(second);
  });
});
