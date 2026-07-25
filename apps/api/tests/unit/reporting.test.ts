import { describe, expect, it } from 'vitest';
import { Account, EntrySide } from '@bozorlar/domain';
import { AppError } from '@bozorlar/errors';
import {
  changeBp,
  effectiveRateBp,
  previousPeriod,
  resolvePeriod,
  summarise,
} from '../../src/modules/reporting/index.js';

/**
 * The two pure pieces of reporting: which window a report covers, and what the ledger says
 * happened in it. Everything else is an aggregation over these.
 *
 * The statement arithmetic gets the most attention because a seller will check it against
 * their own notes, and a statement that is wrong once is a statement nobody reads again.
 */

const NOW = new Date('2026-08-02T12:00:00.000Z');

describe('resolvePeriod', () => {
  it('defaults to the last thirty days', () => {
    const period = resolvePeriod({}, NOW);
    expect(period.days).toBe(30);
    expect(period.to).toEqual(NOW);
  });

  it('accepts an explicit window', () => {
    const period = resolvePeriod({ from: '2026-07-01T00:00:00Z', to: '2026-08-01T00:00:00Z' }, NOW);
    expect(period.days).toBe(31);
  });

  it('rejects an inverted range', () => {
    expect(() =>
      resolvePeriod({ from: '2026-08-01T00:00:00Z', to: '2026-07-01T00:00:00Z' }, NOW),
    ).toThrow(AppError);
  });

  it('rejects an empty range', () => {
    const same = '2026-08-01T00:00:00Z';
    expect(() => resolvePeriod({ from: same, to: same }, NOW)).toThrow(AppError);
  });

  it('rejects an unparseable date rather than silently reporting on everything', () => {
    expect(() => resolvePeriod({ from: 'last tuesday' }, NOW)).toThrow(AppError);
  });

  it('refuses a window longer than the cap', () => {
    expect(() =>
      resolvePeriod({ from: '2024-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }, NOW),
    ).toThrow(/at most/);
  });

  it('allows exactly the cap', () => {
    const period = resolvePeriod({ from: '2025-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' }, NOW);
    expect(period.days).toBe(366);
  });
});

describe('previousPeriod', () => {
  it('is the same length, immediately before, and does not overlap', () => {
    const period = resolvePeriod({ from: '2026-07-01T00:00:00Z', to: '2026-07-11T00:00:00Z' }, NOW);
    const prior = previousPeriod(period);
    expect(prior.to).toEqual(period.from);
    expect(prior.to.getTime() - prior.from.getTime()).toBe(
      period.to.getTime() - period.from.getTime(),
    );
  });

  it('tiles, so adjacent windows can be summed without double counting', () => {
    const period = resolvePeriod({ from: '2026-07-11T00:00:00Z', to: '2026-07-21T00:00:00Z' }, NOW);
    const prior = previousPeriod(period);
    expect(prior.from).toEqual(new Date('2026-07-01T00:00:00.000Z'));
  });
});

describe('changeBp', () => {
  it('reports a rise', () => {
    expect(changeBp(150n, 100n)).toBe(5000);
  });

  it('reports a fall', () => {
    expect(changeBp(50n, 100n)).toBe(-5000);
  });

  it('returns null rather than inventing a comparison against nothing', () => {
    // A seller's first month has no previous month, and "+100%" would look like a fact.
    expect(changeBp(1000n, 0n)).toBeNull();
  });
});

describe('summarise', () => {
  const commission = (side: EntrySide, amountMinor: bigint) => ({
    account: Account.PLATFORM_REVENUE_COMMISSION,
    side,
    amountMinor,
  });

  it('adds commission credits', () => {
    const out = summarise([commission(EntrySide.CREDIT, 500n), commission(EntrySide.CREDIT, 300n)]);
    expect(out.commissionChargedMinor).toBe(800n);
    expect(out.commissionNetMinor).toBe(800n);
  });

  it('subtracts a reversal from the net without erasing the charge', () => {
    // Both figures matter on a statement: the seller was charged, and then given some back.
    const out = summarise([commission(EntrySide.CREDIT, 800n), commission(EntrySide.DEBIT, 300n)]);
    expect(out.commissionChargedMinor).toBe(800n);
    expect(out.commissionReversedMinor).toBe(300n);
    expect(out.commissionNetMinor).toBe(500n);
  });

  it('gives the same answer whichever order the lines arrive in', () => {
    const forwards = summarise([commission(EntrySide.CREDIT, 800n), commission(EntrySide.DEBIT, 300n)]);
    const backwards = summarise([commission(EntrySide.DEBIT, 300n), commission(EntrySide.CREDIT, 800n)]);
    expect(backwards).toEqual(forwards);
  });

  it('counts a top-up as cash in', () => {
    const out = summarise([
      { account: Account.PLATFORM_CASH, side: EntrySide.DEBIT, amountMinor: 10_000n },
    ]);
    expect(out.topUpMinor).toBe(10_000n);
  });

  it('ignores the wallet side, which mirrors every other movement', () => {
    // Counting it would double every figure on the statement.
    const out = summarise([
      { account: Account.PLATFORM_CASH, side: EntrySide.DEBIT, amountMinor: 10_000n },
      { account: Account.SELLER_WALLET, side: EntrySide.CREDIT, amountMinor: 10_000n },
    ]);
    expect(out.topUpMinor).toBe(10_000n);
  });

  it('nets adjustments in the direction the seller experiences them', () => {
    const out = summarise([
      { account: Account.PLATFORM_ADJUSTMENT, side: EntrySide.DEBIT, amountMinor: 500n },
      { account: Account.PLATFORM_ADJUSTMENT, side: EntrySide.CREDIT, amountMinor: 200n },
    ]);
    expect(out.adjustmentMinor).toBe(300n);
  });

  it('is zero for an empty period rather than undefined', () => {
    const out = summarise([]);
    expect(out.commissionNetMinor).toBe(0n);
    expect(out.topUpMinor).toBe(0n);
  });

  it('stays exact at amounts that would lose precision as a float', () => {
    // Nine trillion tiyin is past 2^53; a Number would round it.
    const huge = 9_007_199_254_740_993n;
    const out = summarise([commission(EntrySide.CREDIT, huge)]);
    expect(out.commissionNetMinor).toBe(huge);
  });
});

describe('effectiveRateBp', () => {
  it('reports the rate actually paid', () => {
    expect(effectiveRateBp(500n, 10_000n)).toBe(500);
  });

  it('reflects a reversal, so it can differ from the configured rule', () => {
    // Charged 5%, half reversed after a dispute: the seller paid 2.5%, and that is the number
    // they can check against their own takings.
    expect(effectiveRateBp(250n, 10_000n)).toBe(250);
  });

  it('returns null when there were no sales, rather than dividing by zero', () => {
    expect(effectiveRateBp(0n, 0n)).toBeNull();
  });
});
