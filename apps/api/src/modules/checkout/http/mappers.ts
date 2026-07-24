import { Money } from '@bozorlar/money';
import { resolveLocalized, type Locale, type LocalizedText } from '@bozorlar/types';
import type { CartView } from '../services/cart.service.js';
import type { QuoteIssue } from '../services/quote.service.js';
import type { QuoteRecord } from '../repositories/quote.repository.js';

export interface ViewOptions {
  locale: Locale;
  cdnBaseUrl: string;
}

const text = (value: LocalizedText | null, options: ViewOptions): string | null =>
  value === null ? null : resolveLocalized(value, options.locale);

export function toCartResponse(cart: CartView, options: ViewOptions) {
  return {
    items: cart.lines.map((line) => ({
      lineId: line.lineId,
      productId: line.productId,
      shopId: line.shopId,
      name: text(line.name, options),
      slug: line.slug,
      imageUrl: line.imageKey
        ? `${options.cdnBaseUrl.replace(/\/$/, '')}/${line.imageKey.replace(/\.[^./]+$/, '_thumb.webp')}`
        : null,
      qty: line.qty.toDTO(),
      unitPrice: line.unitPrice?.toDTO() ?? null,
      lineTotal: line.lineTotal?.toDTO() ?? null,
      priceChanged: line.priceChanged,
      purchasable: line.purchasable,
      // Per line, not per cart: a buyer with twelve items and one problem needs to know
      // which one.
      issues: line.issues.map((issue) => ({ code: issue.code, ...(issue.params ?? {}) })),
    })),
    shopGroups: cart.shopGroups.map((group) => ({
      shopId: group.shopId,
      lineIds: group.lineIds,
      subtotal: group.subtotal.toDTO(),
    })),
    subtotal: cart.subtotal.toDTO(),
    itemCount: cart.itemCount,
    hasIssues: cart.hasBlockingIssues,
    updatedAt: cart.updatedAt.toISOString(),
  };
}

export function toQuoteResponse(quote: QuoteRecord, issues: QuoteIssue[], options: ViewOptions) {
  return {
    quoteId: quote.quoteId,
    expiresAt: quote.expiresAt.toISOString(),
    paymentMode: quote.paymentMode,
    groups: quote.groups.map((group) => ({
      shopId: group.shopId.toString(),
      shopName: text(group.shopName, options),
      marketId: group.marketId.toString(),
      marketName: text(group.marketName, options),
      lines: group.lines.map((line) => ({
        lineId: line.lineId,
        productId: line.productId.toString(),
        name: text(line.productName, options),
        slug: line.productSlug,
        qty: { value: line.qtyMilli.toString(), unit: line.unit },
        unitPrice: Money.of(line.unitPrice).toDTO(),
        lineTotal: Money.of(line.lineTotal).toDTO(),
        // Surfaced on the quote so the buyer sees the handover tolerance before ordering,
        // not for the first time when the weight differs (ADR-0006).
        tolerancePercent: line.tolerancePercent,
      })),
      subtotal: Money.of(group.subtotal).toDTO(),
      total: Money.of(group.total).toDTO(),
      pickupWindow: { from: group.pickupFrom.toISOString(), to: group.pickupTo.toISOString() },
    })),
    grandTotal: Money.of(quote.grandTotal).toDTO(),
    issues: issues.map((issue) => ({
      lineId: issue.lineId,
      productId: issue.productId,
      code: issue.code,
      ...(issue.params ?? {}),
    })),
  };
}
