import { describe, expect, it } from 'vitest';
import { Money } from '@bozorlar/money';
import {
  Account,
  EntrySide,
  WalletState,
  assertBalanced,
  evaluateWalletState,
  walletDelta,
  type LedgerLine,
} from '@bozorlar/domain';

const line = (account: Account, side: EntrySide, amount: string): LedgerLine => ({
  account,
  side,
  amountMinor: BigInt(amount),
});

describe('double-entry invariant', () => {
  it('accepts a balanced pair', () => {
    expect(() =>
      assertBalanced([
        line(Account.SELLER_WALLET, EntrySide.DEBIT, '13500'),
        line(Account.PLATFORM_REVENUE_COMMISSION, EntrySide.CREDIT, '13500'),
      ]),
    ).not.toThrow();
  });

  it('rejects an entry that does not balance', () => {
    // The one invariant that makes a ledger trustworthy retrospectively.
    expect(() =>
      assertBalanced([
        line(Account.SELLER_WALLET, EntrySide.DEBIT, '13500'),
        line(Account.PLATFORM_REVENUE_COMMISSION, EntrySide.CREDIT, '13400'),
      ]),
    ).toThrow(/does not balance/);
  });

  it('rejects a single-sided entry', () => {
    expect(() => assertBalanced([line(Account.SELLER_WALLET, EntrySide.DEBIT, '100')])).toThrow();
  });

  it('rejects zero and negative amounts', () => {
    // Direction is carried by the side, never by the sign; a negative credit is ambiguous.
    expect(() =>
      assertBalanced([
        line(Account.SELLER_WALLET, EntrySide.DEBIT, '0'),
        line(Account.PLATFORM_CASH, EntrySide.CREDIT, '0'),
      ]),
    ).toThrow(/positive amount/);
    expect(() =>
      assertBalanced([
        { account: Account.SELLER_WALLET, side: EntrySide.DEBIT, amountMinor: -100n },
        line(Account.PLATFORM_CASH, EntrySide.CREDIT, '100'),
      ]),
    ).toThrow();
  });

  it('balances a multi-line entry', () => {
    expect(() =>
      assertBalanced([
        line(Account.SELLER_WALLET, EntrySide.DEBIT, '6000'),
        line(Account.SELLER_WALLET, EntrySide.DEBIT, '4000'),
        line(Account.PLATFORM_REVENUE_COMMISSION, EntrySide.CREDIT, '10000'),
      ]),
    ).not.toThrow();
  });
});

describe('wallet delta', () => {
  it('treats a credit to the wallet as money the seller gains', () => {
    // SELLER_WALLET is a liability: crediting it increases what the platform owes them.
    expect(
      walletDelta([
        line(Account.PLATFORM_ADJUSTMENT, EntrySide.DEBIT, '50000'),
        line(Account.SELLER_WALLET, EntrySide.CREDIT, '50000'),
      ]),
    ).toBe(50_000n);
  });

  it('treats a debit to the wallet as money the seller spends', () => {
    expect(
      walletDelta([
        line(Account.SELLER_WALLET, EntrySide.DEBIT, '13500'),
        line(Account.PLATFORM_REVENUE_COMMISSION, EntrySide.CREDIT, '13500'),
      ]),
    ).toBe(-13_500n);
  });

  it('ignores lines that do not touch a wallet', () => {
    expect(
      walletDelta([
        line(Account.PLATFORM_CASH, EntrySide.DEBIT, '100'),
        line(Account.PLATFORM_REVENUE_COMMISSION, EntrySide.CREDIT, '100'),
      ]),
    ).toBe(0n);
  });
});

describe('wallet state', () => {
  const base = {
    lowBalanceThresholdMinor: 5_000_00n,
    deactivateBelowMinor: 0n,
    belowFloorSince: null,
    graceHours: 24,
    now: new Date('2026-07-24T12:00:00Z'),
  };

  it('is active with a healthy balance', () => {
    expect(evaluateWalletState({ ...base, balanceMinor: 50_000_00n })).toEqual({
      state: WalletState.ACTIVE,
      shouldDeactivate: false,
    });
  });

  it('warns at or below the low threshold without stopping trade', () => {
    const result = evaluateWalletState({ ...base, balanceMinor: 5_000_00n });
    expect(result.state).toBe(WalletState.LOW);
    expect(result.shouldDeactivate).toBe(false);
  });

  it('gives a grace period before hiding the seller', () => {
    // Cutting a stall off mid-morning over a few thousand som would cost them a day's trade.
    const justBelow = evaluateWalletState({
      ...base,
      balanceMinor: -100n,
      belowFloorSince: new Date('2026-07-24T06:00:00Z'),
    });
    expect(justBelow.state).toBe(WalletState.LOW);
    expect(justBelow.shouldDeactivate).toBe(false);
  });

  it('deactivates once the grace period has run out', () => {
    const expired = evaluateWalletState({
      ...base,
      balanceMinor: -100n,
      belowFloorSince: new Date('2026-07-23T06:00:00Z'),
    });
    expect(expired.state).toBe(WalletState.INACTIVE);
    expect(expired.shouldDeactivate).toBe(true);
  });

  it('deactivates immediately when there is no grace configured', () => {
    const result = evaluateWalletState({ ...base, balanceMinor: 0n, graceHours: 0 });
    expect(result.state).toBe(WalletState.INACTIVE);
    expect(result.shouldDeactivate).toBe(true);
  });

  it('lets the balance go negative rather than refusing a charge', () => {
    // Refusing would mean the platform silently working for free.
    const result = evaluateWalletState({ ...base, balanceMinor: -250_000_00n, graceHours: 0 });
    expect(result.state).toBe(WalletState.INACTIVE);
  });
});

describe('commission arithmetic', () => {
  it('rounds half-up, once, on the gross total', () => {
    // 3% of 45 000.00 UZS = 1 350.00.
    expect(Money.of('4500000').percentBp(300).toStorage()).toBe('135000');
    // 2.5% of 1 001 tiyin = 25.025 -> 25.
    expect(Money.of('1001').percentBp(250).toStorage()).toBe('25');
  });

  it('applies a floor and a ceiling', () => {
    const charge = Money.of('100000').percentBp(300);
    expect(charge.clamp(Money.of('5000'), null).toStorage()).toBe('5000');
    expect(charge.clamp(null, Money.of('1000')).toStorage()).toBe('1000');
    // Null bounds are how "no floor" and "no ceiling" arrive from the database.
    expect(charge.clamp(null, null).toStorage()).toBe(charge.toStorage());
  });

  it('never produces a fractional charge', () => {
    for (const bp of [1, 37, 250, 333, 999]) {
      const charge = Money.of('4500000').percentBp(bp);
      expect(charge.toStorage()).toMatch(/^\d+$/);
    }
  });
});
