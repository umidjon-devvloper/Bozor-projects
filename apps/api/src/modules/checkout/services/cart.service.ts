import { randomBytes } from 'node:crypto';
import { AppError, ErrorCode, notFound } from '@bozorlar/errors';
import { Money, Quantity } from '@bozorlar/money';
import type { LocalizedText } from '@bozorlar/types';
import type { ProductRecord, ProductService } from '../../catalog/index.js';
import { cartRepository, type CartRecord } from '../repositories/cart.repository.js';
import { ADVISORY_ISSUES, LineIssue, MAX_CART_ITEMS } from '../checkout.constants.js';

export interface CartLineIssue {
  code: LineIssue;
  params?: Record<string, unknown>;
}

export interface CartLineView {
  lineId: string;
  productId: string;
  shopId: string;
  name: LocalizedText | null;
  slug: string | null;
  imageKey: string | null;
  unit: string;
  qty: Quantity;
  unitPrice: Money | null;
  lineTotal: Money | null;
  priceAtAdd: Money;
  priceChanged: boolean;
  issues: CartLineIssue[];
  purchasable: boolean;
}

export interface CartView {
  lines: CartLineView[];
  shopGroups: Array<{ shopId: string; lineIds: string[]; subtotal: Money }>;
  subtotal: Money;
  itemCount: number;
  hasBlockingIssues: boolean;
  updatedAt: Date;
}

/**
 * Evaluates a cart line against the live product.
 *
 * Shared by the cart view and the quote so the buyer cannot be shown a green cart and then
 * refused at checkout for a reason the cart already knew about.
 */
export function evaluateLine(
  qty: Quantity,
  product: ProductRecord | undefined,
  priceAtAdd: Money,
): { issues: CartLineIssue[]; blocking: boolean } {
  const issues: CartLineIssue[] = [];

  if (!product) {
    return { issues: [{ code: LineIssue.PRODUCT_GONE }], blocking: true };
  }
  if (!product.isVisible) {
    issues.push({
      code:
        product.visibilityReason === 'SHOP_NOT_VISIBLE'
          ? LineIssue.SHOP_NOT_VISIBLE
          : LineIssue.PRODUCT_NOT_VISIBLE,
    });
  }
  if (qty.milli < product.minOrderQty.milli) {
    issues.push({
      code: LineIssue.BELOW_MIN_ORDER,
      params: { minOrderQty: product.minOrderQty.toDTO() },
    });
  }
  if (product.maxOrderQty !== null && qty.milli > product.maxOrderQty.milli) {
    issues.push({
      code: LineIssue.ABOVE_MAX_ORDER,
      params: { maxOrderQty: product.maxOrderQty.toDTO() },
    });
  }
  if (qty.milli % product.stepQty.milli !== 0n) {
    issues.push({ code: LineIssue.NOT_A_MULTIPLE_OF_STEP, params: { stepQty: product.stepQty.toDTO() } });
  }
  if (product.availableQty.milli < product.minOrderQty.milli) {
    issues.push({ code: LineIssue.OUT_OF_STOCK });
  } else if (product.availableQty.milli < qty.milli) {
    issues.push({
      code: LineIssue.INSUFFICIENT_STOCK,
      params: { availableQty: product.availableQty.toDTO() },
    });
  }
  if (!product.price.equals(priceAtAdd)) {
    // Advisory, not blocking: the buyer is told, and the quote prices at the live figure.
    issues.push({
      code: LineIssue.PRICE_CHANGED,
      params: { from: priceAtAdd.toDTO(), to: product.price.toDTO() },
    });
  }

  const blocking = issues.some((issue) => !ADVISORY_ISSUES.includes(issue.code));
  return { issues, blocking };
}

export function createCartService(deps: { products: ProductService }) {
  const { products } = deps;

  async function loadCart(buyerId: string): Promise<{ cart: CartRecord; catalog: Map<string, ProductRecord> }> {
    const raw = await cartRepository.findRaw(buyerId);
    if (!raw) return { cart: cartRepository.emptyRecord(buyerId), catalog: new Map() };

    // Units live on the product, so they are resolved before the cart is materialised rather
    // than duplicated onto every line where they could drift.
    const productIds = cartRepository.itemsOf(raw).map((item) => item.productId.toString());
    const catalog = await products.findForCheckout(productIds);
    const units = new Map([...catalog].map(([id, product]) => [id, product.unit]));
    return { cart: cartRepository.toRecord(raw, units), catalog };
  }

  function buildView(cart: CartRecord, catalog: Map<string, ProductRecord>): CartView {
    const lines: CartLineView[] = cart.lines.map((line) => {
      const product = catalog.get(line.productId);
      const { issues, blocking } = evaluateLine(line.qty, product, line.priceAtAdd);
      const lineTotal = product ? line.qty.multiplyPrice(product.price) : null;
      return {
        lineId: line.lineId,
        productId: line.productId,
        shopId: line.shopId,
        name: product?.name ?? null,
        slug: product?.slug ?? null,
        imageKey: product?.images[0]?.mediaKey ?? null,
        unit: product?.unit ?? line.qty.unit,
        qty: line.qty,
        unitPrice: product?.price ?? null,
        lineTotal,
        priceAtAdd: line.priceAtAdd,
        priceChanged: Boolean(product && !product.price.equals(line.priceAtAdd)),
        issues,
        purchasable: !blocking,
      };
    });

    const groups = new Map<string, { lineIds: string[]; subtotal: Money }>();
    for (const line of lines) {
      const group = groups.get(line.shopId) ?? { lineIds: [], subtotal: Money.zero() };
      group.lineIds.push(line.lineId);
      if (line.lineTotal) group.subtotal = group.subtotal.add(line.lineTotal);
      groups.set(line.shopId, group);
    }

    return {
      lines,
      shopGroups: [...groups].map(([shopId, group]) => ({ shopId, ...group })),
      subtotal: Money.sum(lines.map((line) => line.lineTotal ?? Money.zero())),
      itemCount: lines.length,
      hasBlockingIssues: lines.some((line) => !line.purchasable),
      updatedAt: cart.updatedAt,
    };
  }

  return {
    async get(buyerId: string): Promise<CartView> {
      const { cart, catalog } = await loadCart(buyerId);
      return buildView(cart, catalog);
    },

    /** Internal: the quote needs the raw lines and the products they point at. */
    async load(buyerId: string) {
      return loadCart(buyerId);
    },

    async addItem(buyerId: string, productId: string, qtyValue: string): Promise<CartView> {
      const catalog = await products.findForCheckout([productId]);
      const product = catalog.get(productId);
      if (!product || !product.isVisible) throw notFound('Product');

      const qty = Quantity.of(qtyValue, product.unit);
      if (qty.milli <= 0n) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, { detail: 'Quantity must be above zero' });
      }
      if (qty.milli < product.minOrderQty.milli) {
        throw new AppError(ErrorCode.CART_QTY_BELOW_MINIMUM, {
          detail: 'Below the minimum order for this product',
          params: { minOrderQty: product.minOrderQty.toDTO() },
        });
      }
      if (qty.milli % product.stepQty.milli !== 0n) {
        throw new AppError(ErrorCode.CART_QTY_STEP_INVALID, {
          detail: 'Quantity must be a whole number of steps',
          params: { stepQty: product.stepQty.toDTO() },
        });
      }

      await cartRepository.ensureExists(buyerId);
      if ((await cartRepository.countItems(buyerId)) >= MAX_CART_ITEMS) {
        const existing = await cartRepository.findRaw(buyerId);
        const alreadyThere = existing?.items.some((item) => item.productId.toString() === productId);
        if (!alreadyThere) {
          throw new AppError(ErrorCode.CART_ITEM_LIMIT_EXCEEDED, {
            detail: `A cart may hold at most ${MAX_CART_ITEMS} different products`,
          });
        }
      }

      await cartRepository.addOrIncrement(buyerId, {
        lineId: randomBytes(8).toString('hex'),
        productId,
        shopId: product.shopId,
        qty,
        price: product.price,
      });
      return this.get(buyerId);
    },

    async setQuantity(buyerId: string, lineId: string, qtyValue: string): Promise<CartView> {
      const { cart, catalog } = await loadCart(buyerId);
      const line = cart.lines.find((candidate) => candidate.lineId === lineId);
      if (!line) throw notFound('Cart line');

      const product = catalog.get(line.productId);
      if (!product) throw notFound('Product');

      const qty = Quantity.of(qtyValue, product.unit);
      if (qty.milli < product.minOrderQty.milli) {
        throw new AppError(ErrorCode.CART_QTY_BELOW_MINIMUM, {
          detail: 'Below the minimum order for this product',
          params: { minOrderQty: product.minOrderQty.toDTO() },
        });
      }
      if (qty.milli % product.stepQty.milli !== 0n) {
        throw new AppError(ErrorCode.CART_QTY_STEP_INVALID, {
          detail: 'Quantity must be a whole number of steps',
          params: { stepQty: product.stepQty.toDTO() },
        });
      }

      await cartRepository.setQuantity(buyerId, lineId, qty);
      return this.get(buyerId);
    },

    async removeLine(buyerId: string, lineId: string): Promise<CartView> {
      if (!(await cartRepository.removeLine(buyerId, lineId))) throw notFound('Cart line');
      return this.get(buyerId);
    },

    async clear(buyerId: string): Promise<void> {
      await cartRepository.clear(buyerId);
    },

    /**
     * Merges a guest cart into the signed-in one.
     *
     * Quantities are added rather than replaced: someone who put two kilos in as a guest and
     * one more after signing in wants three, not one. Lines that no longer validate are
     * reported rather than silently dropped.
     */
    async merge(
      buyerId: string,
      items: ReadonlyArray<{ productId: string; qty: string }>,
    ): Promise<{ cart: CartView; rejected: Array<{ productId: string; reason: string }> }> {
      const rejected: Array<{ productId: string; reason: string }> = [];
      const catalog = await products.findForCheckout(items.map((item) => item.productId));

      for (const item of items) {
        const product = catalog.get(item.productId);
        if (!product || !product.isVisible) {
          rejected.push({ productId: item.productId, reason: LineIssue.PRODUCT_GONE });
          continue;
        }
        const qty = Quantity.of(item.qty, product.unit);
        if (qty.milli < product.minOrderQty.milli || qty.milli % product.stepQty.milli !== 0n) {
          rejected.push({ productId: item.productId, reason: LineIssue.BELOW_MIN_ORDER });
          continue;
        }
        await cartRepository.ensureExists(buyerId);
        await cartRepository.addOrIncrement(buyerId, {
          lineId: randomBytes(8).toString('hex'),
          productId: item.productId,
          shopId: product.shopId,
          qty,
          price: product.price,
        });
      }

      return { cart: await this.get(buyerId), rejected };
    },

    buildView,
  };
}

export type CartService = ReturnType<typeof createCartService>;
