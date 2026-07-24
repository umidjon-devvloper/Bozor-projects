import { describe, expect, it } from 'vitest';
import { Money, Quantity, divideRoundHalfUp } from '../src/index.js';

describe('Money', () => {
  it('parses and serialises minor units as strings (ADR-0028)', () => {
    expect(Money.of('4500000').toDTO()).toEqual({ amount: '4500000', currency: 'UZS' });
  });

  it('rejects unsafe integers rather than truncating silently', () => {
    expect(() => Money.of(Number.MAX_SAFE_INTEGER + 2)).toThrow();
  });

  it('adds without float drift', () => {
    const total = Money.sum([Money.of('10'), Money.of('20'), Money.of('30')]);
    expect(total.toStorage()).toBe('60');
  });

  it('rounds commission half-up, once', () => {
    // 2.5% of 1 001 tiyin = 25.025 -> 25
    expect(Money.of('1001').percentBp(250).toStorage()).toBe('25');
    // 3% of 200 000 000 tiyin = 6 000 000 exactly
    expect(Money.of('200000000').percentBp(300).toStorage()).toBe('6000000');
    // half rounds up, not to even
    expect(divideRoundHalfUp(5n, 2n)).toBe(3n);
  });

  it('clamps to min and max', () => {
    const value = Money.of('50');
    expect(value.clamp(Money.of('100')).toStorage()).toBe('100');
    expect(value.clamp(undefined, Money.of('20')).toStorage()).toBe('20');
  });

  it('refuses to mix currencies', () => {
    const uzs = Money.of('100', 'UZS');
    const other = Money.of('100', 'USD' as 'UZS');
    expect(() => uzs.add(other)).toThrow();
  });

  it('formats major units for display', () => {
    expect(Money.of('1800050').toMajorString()).toBe('18000.50');
    expect(Money.fromMajor('18000.50').toStorage()).toBe('1800050');
  });
});

describe('Quantity', () => {
  it('computes a line total with integer arithmetic (ADR-0025)', () => {
    // 2.5 kg at 18 000.00 UZS/kg = 45 000.00 UZS
    const qty = Quantity.fromDecimal('2.5', 'kg');
    expect(qty.multiplyPrice(Money.of('1800000')).toStorage()).toBe('4500000');
  });

  it('sums 20 fractional lines exactly', () => {
    const unitPrice = Money.of('1800000');
    const lines = Array.from({ length: 20 }, () => Quantity.fromDecimal('0.375', 'kg'));
    const total = Money.sum(lines.map((q) => q.multiplyPrice(unitPrice)));
    // 0.375 * 20 = 7.5 kg -> 135 000.00 UZS. A float pipeline drifts here.
    expect(total.toStorage()).toBe('13500000');
  });

  it('reports tolerance delta in basis points', () => {
    const ordered = Quantity.fromDecimal('2.5', 'kg');
    const confirmed = Quantity.fromDecimal('2.38', 'kg');
    expect(confirmed.deltaBpFrom(ordered)).toBe(480); // 4.8%
  });

  it('validates step multiples', () => {
    const step = Quantity.fromDecimal('0.5', 'kg');
    expect(Quantity.fromDecimal('2.5', 'kg').isMultipleOf(step)).toBe(true);
    expect(Quantity.fromDecimal('2.3', 'kg').isMultipleOf(step)).toBe(false);
  });

  it('never goes negative', () => {
    expect(() => Quantity.fromDecimal('1', 'kg').subtract(Quantity.fromDecimal('2', 'kg'))).toThrow();
  });
});
