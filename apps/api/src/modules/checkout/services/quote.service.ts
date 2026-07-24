import { createHash, randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { AppError, ErrorCode, notFound } from '@bozorlar/errors';
import type { Logger } from '@bozorlar/logger';
import { Money, Quantity } from '@bozorlar/money';
import { ActorType, type LocalizedText, type WorkingHoursEntry } from '@bozorlar/types';
import { evaluateOpening } from '../../geo/index.js';
import type { ProductRecord } from '../../catalog/index.js';
import { outboxService } from '../../outbox/index.js';
import { reservationRepository } from '../repositories/reservation.repository.js';
import { quoteRepository, type QuoteRecord } from '../repositories/quote.repository.js';
import type { QuoteGroup, QuoteLine } from '../models/checkoutQuote.model.js';
import { evaluateLine, type CartLineIssue, type CartService } from './cart.service.js';
import {
  LineIssue,
  MAX_SHOPS_PER_QUOTE,
  PICKUP_WINDOW_HOURS,
  QUOTE_TTL_MINUTES,
  RESERVATION_TTL_MINUTES,
  ReservationStatus,
} from '../checkout.constants.js';
import { CheckoutEvents } from '../events.js';

export interface ShopSummary {
  id: string;
  name: LocalizedText;
  marketId: string;
  marketName: LocalizedText;
  isVisible: boolean;
  workingHours: WorkingHoursEntry[];
  timezone: string;
}

export interface ShopSummaryLookup {
  findCheckoutSummaries(shopIds: readonly string[]): Promise<Map<string, ShopSummary>>;
}

export interface QuoteIssue extends CartLineIssue {
  lineId: string;
  productId: string;
}

/**
 * Digest of everything the buyer is being asked to agree to.
 *
 * Order creation recomputes this against live products. If it differs, something moved after
 * the quote was shown and the buyer is re-quoted rather than charged a different figure — the
 * whole reason a quote exists (CART_CHECKOUT.md).
 */
export function computeContentHash(groups: readonly QuoteGroup[]): string {
  const canonical = groups
    .map((group) =>
      [
        group.shopId.toString(),
        ...group.lines.map((line) =>
          [line.productId.toString(), line.unitPrice.toString(), line.qtyMilli.toString()].join(':'),
        ),
      ].join('|'),
    )
    .sort()
    .join('||');
  return createHash('sha256').update(canonical).digest('hex');
}

export function createQuoteService(deps: {
  cart: CartService;
  shops: ShopSummaryLookup;
  logger: Logger;
}) {
  // The catalogue is reached through the cart, which already loads it. Taking a second
  // reference here would invite a divergent lookup path for the same products.
  const { cart, shops, logger } = deps;

  /**
   * When the buyer can collect.
   *
   * A bazaar seller will happily prepare an order placed at 04:00 for collection when the
   * stall opens, so an order outside working hours is accepted and the window simply starts
   * at the next opening rather than now (MARKET_SYSTEM.md).
   */
  function pickupWindow(shop: ShopSummary, now: Date): { from: Date; to: Date } {
    const opening = evaluateOpening(shop.workingHours, shop.timezone, now);
    const from = opening.isOpenNow ? now : (opening.opensNextAt ?? now);
    return { from, to: new Date(from.getTime() + PICKUP_WINDOW_HOURS * 60 * 60 * 1000) };
  }

  return {
    /**
     * Prices a cart, reserves the stock, and returns a time-boxed offer.
     *
     * Everything is re-read from the database: the cart is a list of intentions, not a
     * statement of price. Nothing the client sends contributes to a total.
     */
    async createQuote(input: {
      buyerId: string;
      lineIds?: readonly string[] | undefined;
    }): Promise<{ quote: QuoteRecord; issues: QuoteIssue[] }> {
      const { cart: cartRecord, catalog } = await cart.load(input.buyerId);
      const selected =
        input.lineIds && input.lineIds.length > 0
          ? cartRecord.lines.filter((line) => input.lineIds?.includes(line.lineId))
          : cartRecord.lines;

      if (selected.length === 0) {
        throw new AppError(ErrorCode.CHECKOUT_EMPTY_CART, { detail: 'There is nothing to check out' });
      }

      // Every line is evaluated before anything is reserved, so a buyer with one bad line is
      // told which line rather than being told "checkout failed".
      const issues: QuoteIssue[] = [];
      const priceable: Array<{ line: (typeof selected)[number]; product: ProductRecord }> = [];
      for (const line of selected) {
        const product = catalog.get(line.productId);
        const evaluation = evaluateLine(line.qty, product, line.priceAtAdd);
        for (const issue of evaluation.issues) {
          issues.push({ ...issue, lineId: line.lineId, productId: line.productId });
        }
        if (!evaluation.blocking && product) priceable.push({ line, product });
      }

      const blocking = issues.filter((issue) => issue.code !== LineIssue.PRICE_CHANGED);
      if (blocking.length > 0) {
        throw new AppError(ErrorCode.CHECKOUT_STOCK_CHANGED, {
          detail: 'Some items in your basket are no longer available as ordered',
          errors: blocking.map((issue) => ({
            field: `lines.${issue.lineId}`,
            code: issue.code,
            ...(issue.params ? { params: issue.params } : {}),
          })),
        });
      }

      const shopIds = [...new Set(priceable.map((entry) => entry.product.shopId))];
      if (shopIds.length > MAX_SHOPS_PER_QUOTE) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, {
          detail: `A single checkout may span at most ${MAX_SHOPS_PER_QUOTE} shops`,
        });
      }
      const summaries = await shops.findCheckoutSummaries(shopIds);
      for (const shopId of shopIds) {
        const summary = summaries.get(shopId);
        if (!summary || !summary.isVisible) {
          throw new AppError(ErrorCode.CHECKOUT_SELLER_INACTIVE, {
            detail: 'One of the sellers in your basket is not currently trading',
            params: { shopId },
          });
        }
      }

      const now = new Date();
      const quoteId = `q_${randomBytes(12).toString('hex')}`;
      const expiresAt = new Date(now.getTime() + QUOTE_TTL_MINUTES * 60 * 1000);
      const reservationExpiresAt = new Date(now.getTime() + RESERVATION_TTL_MINUTES * 60 * 1000);

      // Grouped per shop: acceptance, pickup and commission are all per seller (ADR-0007).
      const grouped = new Map<string, QuoteLine[]>();
      for (const { line, product } of priceable) {
        const lineTotal = line.qty.multiplyPrice(product.price);
        const quoteLine: QuoteLine = {
          lineId: line.lineId,
          productId: new mongoose.Types.ObjectId(product.id),
          productName: product.name,
          productSlug: product.slug,
          imageKey: product.images[0]?.mediaKey ?? null,
          unit: product.unit,
          unitPrice: product.price.minor,
          qtyMilli: line.qty.milli,
          lineTotal: lineTotal.minor,
          tolerancePercent: product.tolerancePercent,
        };
        grouped.set(product.shopId, [...(grouped.get(product.shopId) ?? []), quoteLine]);
      }

      const groups: QuoteGroup[] = [...grouped].map(([shopId, lines]) => {
        const summary = summaries.get(shopId);
        if (!summary) throw notFound('Shop');
        const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0n);
        const window = pickupWindow(summary, now);
        return {
          shopId: new mongoose.Types.ObjectId(shopId),
          shopName: summary.name,
          marketId: new mongoose.Types.ObjectId(summary.marketId),
          marketName: summary.marketName,
          lines,
          subtotal,
          total: subtotal,
          pickupFrom: window.from,
          pickupTo: window.to,
        };
      });

      const grandTotal = groups.reduce((sum, group) => sum + group.total, 0n);
      const contentHash = computeContentHash(groups);

      const session = await mongoose.startSession();
      let quote: QuoteRecord;
      try {
        quote = await session.withTransaction(async () => {
          // One live offer per buyer: holding stock through several quotes at once would let
          // one indecisive shopper starve everybody else.
          const superseded = await quoteRepository.supersedeActive(input.buyerId, session);
          for (const previousQuoteId of superseded) {
            await this.releaseHolds(previousQuoteId, ReservationStatus.RELEASED, session);
          }

          for (const { line, product } of priceable) {
            const held = await reservationRepository.tryHold(product.id, line.qty, session);
            if (!held) {
              // Lost the race for the last of it. Aborting the transaction gives back every
              // hold taken so far, so a failed quote never strands stock.
              throw new AppError(ErrorCode.CHECKOUT_STOCK_CHANGED, {
                detail: 'Another buyer took the last of this item while you were checking out',
                errors: [
                  {
                    field: `lines.${line.lineId}`,
                    code: LineIssue.INSUFFICIENT_STOCK,
                    params: { productId: product.id },
                  },
                ],
              });
            }
            await reservationRepository.create(
              {
                productId: product.id,
                shopId: product.shopId,
                buyerId: input.buyerId,
                holderType: 'QUOTE',
                holderId: quoteId,
                qty: line.qty,
                expiresAt: reservationExpiresAt,
              },
              session,
            );
          }

          const created = await quoteRepository.create(
            {
              quoteId,
              buyerId: input.buyerId,
              groups,
              grandTotal,
              paymentMode: 'CASH_ON_PICKUP',
              contentHash,
              expiresAt,
            },
            session,
          );

          await outboxService.publish(
            {
              type: CheckoutEvents.QUOTE_CREATED,
              aggregateType: 'checkout_quote',
              aggregateId: quoteId,
              payload: {
                quoteId,
                buyerId: input.buyerId,
                shopCount: groups.length,
                grandTotal: grandTotal.toString(),
              },
              actorId: input.buyerId,
              actorType: ActorType.USER,
            },
            session,
          );
          return created;
        });
      } finally {
        await session.endSession();
      }

      logger.info(
        { quoteId, buyerId: input.buyerId, shops: groups.length, lines: priceable.length },
        'checkout quote issued',
      );
      // Only advisory issues survive to here; blocking ones threw above.
      return { quote, issues };
    },

    async getQuote(quoteId: string, buyerId: string): Promise<QuoteRecord> {
      const quote = await quoteRepository.findByQuoteId(quoteId);
      if (!quote) throw notFound('Quote');
      if (quote.buyerId !== buyerId) throw notFound('Quote', `PERM_SCOPE_DENIED user=${buyerId}`);

      if (quote.status === 'ACTIVE' && quote.expiresAt.getTime() < Date.now()) {
        await quoteRepository.markExpired(quoteId);
        throw new AppError(ErrorCode.CHECKOUT_QUOTE_EXPIRED, {
          detail: 'This quote has expired; please review your basket again',
        });
      }
      if (quote.status !== 'ACTIVE') {
        throw new AppError(ErrorCode.CHECKOUT_QUOTE_EXPIRED, {
          detail: `This quote is no longer valid (${quote.status.toLowerCase()})`,
        });
      }
      return quote;
    },

    /**
     * Gives back every hold attached to a quote.
     *
     * Used when a quote is superseded, when it expires, and by the sweeper. Idempotent: the
     * status filter means a second call finds nothing to release rather than double-crediting
     * the stock counter.
     */
    async releaseHolds(
      holderId: string,
      status: ReservationStatus,
      session: mongoose.ClientSession,
    ): Promise<number> {
      const active = await reservationRepository.findActiveByHolder(holderId);
      if (active.length === 0) return 0;

      for (const reservation of active) {
        await reservationRepository.releaseHold(
          reservation.productId,
          Quantity.of(reservation.qtyMilli, 'unit'),
          session,
        );
      }
      return reservationRepository.markStatus(
        active.map((reservation) => reservation.id),
        status,
        session,
      );
    },

    /** Totals as value objects, for the response mapper. */
    money(value: bigint): Money {
      return Money.of(value);
    },
  };
}

export type QuoteService = ReturnType<typeof createQuoteService>;
