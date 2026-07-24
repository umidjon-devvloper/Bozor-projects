/**
 * Product visibility and purchasability.
 *
 * Two distinct questions, deliberately separated. *Visible* means the product appears in the
 * catalogue; *purchasable* means it can be put in a cart. An out-of-stock product stays
 * visible — a shopper should be able to find it, see that it is finished for today, and
 * favourite it for a restock alert. Hiding it would make the shop look emptier than it is
 * and destroy the restock signal.
 *
 * Pure: no I/O, no clock, no database. Shared because the API computes it on write and the
 * worker recomputes it when a shop's visibility changes (ADR-0011).
 */

export const ProductVisibilityReason = {
  VISIBLE: 'VISIBLE',
  NOT_ACTIVE: 'NOT_ACTIVE',
  MODERATION_NOT_APPROVED: 'MODERATION_NOT_APPROVED',
  SHOP_NOT_VISIBLE: 'SHOP_NOT_VISIBLE',
} as const;
export type ProductVisibilityReason =
  (typeof ProductVisibilityReason)[keyof typeof ProductVisibilityReason];

export interface ProductVisibilityInputs {
  /** ACTIVE or OUT_OF_STOCK both count as live; DRAFT, PENDING_MODERATION, ARCHIVED do not. */
  isLiveStatus: boolean;
  moderationApproved: boolean;
  /** Materialised on the shop by the geo module. */
  shopVisible: boolean;
}

export interface ProductVisibilityResult {
  isVisible: boolean;
  reason: ProductVisibilityReason;
}

export function computeProductVisibility(
  inputs: ProductVisibilityInputs,
): ProductVisibilityResult {
  if (!inputs.isLiveStatus) {
    return { isVisible: false, reason: ProductVisibilityReason.NOT_ACTIVE };
  }
  if (!inputs.moderationApproved) {
    return { isVisible: false, reason: ProductVisibilityReason.MODERATION_NOT_APPROVED };
  }
  if (!inputs.shopVisible) {
    return { isVisible: false, reason: ProductVisibilityReason.SHOP_NOT_VISIBLE };
  }
  return { isVisible: true, reason: ProductVisibilityReason.VISIBLE };
}

export interface PurchasabilityInputs {
  isVisible: boolean;
  /** Milli-units. stock minus anything currently reserved by open checkouts. */
  availableQtyMilli: bigint;
  minOrderQtyMilli: bigint;
}

/**
 * A product is purchasable only if enough remains to satisfy its own minimum order.
 *
 * Comparing against `minOrderQty` rather than zero matters for weighed goods: 200g left when
 * the seller sells in 500g steps is not stock, it is a remainder.
 */
export function isPurchasable(inputs: PurchasabilityInputs): boolean {
  return inputs.isVisible && inputs.availableQtyMilli >= inputs.minOrderQtyMilli;
}
