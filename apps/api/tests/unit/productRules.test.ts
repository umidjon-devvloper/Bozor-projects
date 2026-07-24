import { describe, expect, it } from 'vitest';
import { Money, Quantity } from '@bozorlar/money';
import { computeProductVisibility, isPurchasable, ProductVisibilityReason } from '@bozorlar/domain';
import {
  LIVE_PRODUCT_STATUSES,
  PRODUCT_TRANSITIONS,
  ProductStatus,
  REMODERATION_FIELDS,
} from '../../src/modules/catalog/catalog.constants.js';
import { ProductStatusSchema } from '@bozorlar/contracts';

describe('product visibility', () => {
  const visible = { isLiveStatus: true, moderationApproved: true, shopVisible: true };

  it('is visible only when status, moderation and shop all allow it', () => {
    expect(computeProductVisibility(visible)).toEqual({
      isVisible: true,
      reason: ProductVisibilityReason.VISIBLE,
    });
    expect(computeProductVisibility({ ...visible, isLiveStatus: false }).isVisible).toBe(false);
    expect(computeProductVisibility({ ...visible, moderationApproved: false }).isVisible).toBe(false);
    expect(computeProductVisibility({ ...visible, shopVisible: false })).toEqual({
      isVisible: false,
      reason: ProductVisibilityReason.SHOP_NOT_VISIBLE,
    });
  });

  it('reports the first failing condition in a stable order', () => {
    // The reason is stored and shown to the seller, so it must not flip between causes.
    const result = computeProductVisibility({
      isLiveStatus: false,
      moderationApproved: false,
      shopVisible: false,
    });
    expect(result.reason).toBe(ProductVisibilityReason.NOT_ACTIVE);
  });

  it('keeps an out-of-stock product visible', () => {
    // Hiding it would make the shop look emptier than it is and kill the restock signal.
    expect(LIVE_PRODUCT_STATUSES).toContain(ProductStatus.OUT_OF_STOCK);
  });
});

describe('purchasability', () => {
  const minOrder = Quantity.fromDecimal('0.5', 'kg');

  it('requires enough stock to satisfy the product\'s own minimum', () => {
    // 200g left when the seller sells in 500g steps is a remainder, not stock.
    expect(
      isPurchasable({
        isVisible: true,
        availableQtyMilli: Quantity.fromDecimal('0.2', 'kg').milli,
        minOrderQtyMilli: minOrder.milli,
      }),
    ).toBe(false);
    expect(
      isPurchasable({
        isVisible: true,
        availableQtyMilli: Quantity.fromDecimal('0.5', 'kg').milli,
        minOrderQtyMilli: minOrder.milli,
      }),
    ).toBe(true);
  });

  it('is never purchasable while invisible', () => {
    expect(
      isPurchasable({
        isVisible: false,
        availableQtyMilli: Quantity.fromDecimal('100', 'kg').milli,
        minOrderQtyMilli: minOrder.milli,
      }),
    ).toBe(false);
  });
});

describe('product state machine', () => {
  it('declares transitions for every status', () => {
    for (const status of Object.values(ProductStatus)) {
      expect(PRODUCT_TRANSITIONS[status], status).toBeDefined();
    }
  });

  it('makes archiving final', () => {
    // Historical orders render from line snapshots; resurrecting a product would produce
    // two products sharing one history.
    expect(PRODUCT_TRANSITIONS.ARCHIVED).toHaveLength(0);
  });

  it('cannot publish without passing moderation', () => {
    expect(PRODUCT_TRANSITIONS.DRAFT).not.toContain(ProductStatus.ACTIVE);
    expect(PRODUCT_TRANSITIONS.PENDING_MODERATION).toContain(ProductStatus.ACTIVE);
  });

  it('lets stock move a live product in and out of stock without re-moderation', () => {
    expect(PRODUCT_TRANSITIONS.ACTIVE).toContain(ProductStatus.OUT_OF_STOCK);
    expect(PRODUCT_TRANSITIONS.OUT_OF_STOCK).toContain(ProductStatus.ACTIVE);
  });

  it('keeps the wire enum and the server enum in step', () => {
    expect([...ProductStatusSchema.options].sort()).toEqual(Object.values(ProductStatus).sort());
  });
});

describe('re-moderation policy', () => {
  it('covers the fields a shopper judges the product by', () => {
    expect(REMODERATION_FIELDS).toEqual(
      expect.arrayContaining(['name', 'description', 'images', 'categoryId']),
    );
  });

  it('deliberately excludes price and stock', () => {
    // Bazaar prices move daily and stock moves hourly. Putting either behind human review
    // would make the platform unusable and the moderation queue meaningless.
    expect(REMODERATION_FIELDS).not.toContain('price');
    expect(REMODERATION_FIELDS).not.toContain('stockQty');
  });
});

describe('catalogue arithmetic', () => {
  it('computes a line total for weighed goods without drift', () => {
    // 2.5 kg at 18 000.00 UZS/kg.
    const total = Quantity.fromDecimal('2.5', 'kg').multiplyPrice(Money.of('1800000'));
    expect(total.toStorage()).toBe('4500000');
  });

  it('computes a discount percentage with integer arithmetic', () => {
    const price = Money.of('1800000');
    const oldPrice = Money.of('2000000');
    const percent = Number(((oldPrice.minor - price.minor) * 100n) / oldPrice.minor);
    expect(percent).toBe(10);
  });

  it('rejects a step that cannot reach the minimum order', () => {
    const min = Quantity.fromDecimal('0.5', 'kg');
    const badStep = Quantity.fromDecimal('0.3', 'kg');
    expect(min.milli % badStep.milli === 0n).toBe(false);
    const goodStep = Quantity.fromDecimal('0.25', 'kg');
    expect(min.milli % goodStep.milli === 0n).toBe(true);
  });
});
