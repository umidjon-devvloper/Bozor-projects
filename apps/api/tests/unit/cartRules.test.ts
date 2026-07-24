import { describe, expect, it } from 'vitest';
import { Money, Quantity } from '@bozorlar/money';
import { evaluateLine } from '../../src/modules/checkout/services/cart.service.js';
import { computeContentHash } from '../../src/modules/checkout/services/quote.service.js';
import { ADVISORY_ISSUES, LineIssue } from '../../src/modules/checkout/checkout.constants.js';
import type { ProductRecord } from '../../src/modules/catalog/index.js';

const product = (overrides: Partial<ProductRecord> = {}): ProductRecord =>
  ({
    id: '665f1a2b3c4d5e6f7a8b9c0d',
    shopId: '665f1a2b3c4d5e6f7a8b9c0e',
    unit: 'kg',
    price: Money.of('1800000'),
    availableQty: Quantity.fromDecimal('45', 'kg'),
    minOrderQty: Quantity.fromDecimal('0.5', 'kg'),
    stepQty: Quantity.fromDecimal('0.5', 'kg'),
    maxOrderQty: null,
    isVisible: true,
    visibilityReason: 'VISIBLE',
    ...overrides,
  }) as unknown as ProductRecord;

const qty = (value: string) => Quantity.fromDecimal(value, 'kg');

describe('evaluateLine', () => {
  it('passes a well-formed line', () => {
    const result = evaluateLine(qty('2.5'), product(), Money.of('1800000'));
    expect(result.issues).toHaveLength(0);
    expect(result.blocking).toBe(false);
  });

  it('blocks a deleted product', () => {
    const result = evaluateLine(qty('2.5'), undefined, Money.of('1800000'));
    expect(result.issues[0]?.code).toBe(LineIssue.PRODUCT_GONE);
    expect(result.blocking).toBe(true);
  });

  it('distinguishes a hidden shop from a hidden product', () => {
    // The buyer is told the seller is away, not that the tomato ceased to exist.
    const shopHidden = evaluateLine(
      qty('2.5'),
      product({ isVisible: false, visibilityReason: 'SHOP_NOT_VISIBLE' }),
      Money.of('1800000'),
    );
    expect(shopHidden.issues[0]?.code).toBe(LineIssue.SHOP_NOT_VISIBLE);

    const productHidden = evaluateLine(
      qty('2.5'),
      product({ isVisible: false, visibilityReason: 'MODERATION_NOT_APPROVED' }),
      Money.of('1800000'),
    );
    expect(productHidden.issues[0]?.code).toBe(LineIssue.PRODUCT_NOT_VISIBLE);
  });

  it('separates out-of-stock from not-enough-stock', () => {
    // Nothing sellable left is a different message from "we have some, but not that much".
    const none = evaluateLine(qty('2.5'), product({ availableQty: qty('0.2') }), Money.of('1800000'));
    expect(none.issues.map((i) => i.code)).toContain(LineIssue.OUT_OF_STOCK);

    const some = evaluateLine(qty('2.5'), product({ availableQty: qty('1') }), Money.of('1800000'));
    expect(some.issues.map((i) => i.code)).toContain(LineIssue.INSUFFICIENT_STOCK);
  });

  it('enforces minimum, step and maximum', () => {
    expect(
      evaluateLine(qty('0.25'), product(), Money.of('1800000')).issues.map((i) => i.code),
    ).toContain(LineIssue.BELOW_MIN_ORDER);
    expect(
      evaluateLine(qty('0.75'), product(), Money.of('1800000')).issues.map((i) => i.code),
    ).toContain(LineIssue.NOT_A_MULTIPLE_OF_STEP);
    expect(
      evaluateLine(qty('30'), product({ maxOrderQty: qty('20') }), Money.of('1800000')).issues.map(
        (i) => i.code,
      ),
    ).toContain(LineIssue.ABOVE_MAX_ORDER);
  });

  it('treats a price change as advisory, not blocking', () => {
    // The buyer is told; the quote then prices at the live figure. Refusing checkout because
    // a tomato went up fifty som would be absurd.
    const result = evaluateLine(qty('2.5'), product(), Money.of('1700000'));
    expect(result.issues.map((i) => i.code)).toEqual([LineIssue.PRICE_CHANGED]);
    expect(result.blocking).toBe(false);
    expect(ADVISORY_ISSUES).toContain(LineIssue.PRICE_CHANGED);
  });

  it('reports every problem on a line at once', () => {
    const result = evaluateLine(
      qty('0.3'),
      product({ isVisible: false, availableQty: qty('0.1') }),
      Money.of('1700000'),
    );
    const codes = result.issues.map((issue) => issue.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        LineIssue.PRODUCT_NOT_VISIBLE,
        LineIssue.BELOW_MIN_ORDER,
        LineIssue.NOT_A_MULTIPLE_OF_STEP,
        LineIssue.OUT_OF_STOCK,
        LineIssue.PRICE_CHANGED,
      ]),
    );
  });
});

describe('quote content hash', () => {
  const group = (unitPrice: bigint, qtyMilli: bigint) =>
    [
      {
        shopId: { toString: () => 'shop1' },
        lines: [{ productId: { toString: () => 'p1' }, unitPrice, qtyMilli }],
      },
    ] as never;

  it('is stable for identical content', () => {
    expect(computeContentHash(group(1800000n, 2500n))).toBe(computeContentHash(group(1800000n, 2500n)));
  });

  it('changes when the price changes', () => {
    // This is what makes "charged a different amount than displayed" impossible rather than
    // merely unlikely.
    expect(computeContentHash(group(1800000n, 2500n))).not.toBe(
      computeContentHash(group(1900000n, 2500n)),
    );
  });

  it('changes when the quantity changes', () => {
    expect(computeContentHash(group(1800000n, 2500n))).not.toBe(
      computeContentHash(group(1800000n, 3000n)),
    );
  });

  it('is a sha-256 digest', () => {
    expect(computeContentHash(group(1800000n, 2500n))).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('cart arithmetic', () => {
  it('totals a multi-line basket without drift', () => {
    const unitPrice = Money.of('1800000');
    const lines = ['0.375', '0.375', '2.5', '1.125'].map((value) =>
      Quantity.fromDecimal(value, 'kg').multiplyPrice(unitPrice),
    );
    // 4.375 kg at 18 000.00 = 78 750.00 UZS.
    expect(Money.sum(lines).toStorage()).toBe('7875000');
  });
});
