/**
 * Seller wallet state (WALLET_SYSTEM.md).
 *
 * The commercial rule the whole platform rests on: a seller prepays, every completed order
 * deducts commission, and a seller whose balance runs out stops trading until they top up.
 * Pure, and shared, because the API evaluates it on every charge and the worker evaluates it
 * when reconciling — two copies would eventually disagree about who is allowed to sell.
 */

export const WalletState = {
  ACTIVE: 'ACTIVE',
  /** Still trading, but warned. */
  LOW: 'LOW',
  /** Below zero or past the grace period: hidden everywhere until topped up. */
  INACTIVE: 'INACTIVE',
} as const;
export type WalletState = (typeof WalletState)[keyof typeof WalletState];

export interface WalletStateInputs {
  /** Tiyin. May be negative: a commission charge is never refused for lack of funds. */
  balanceMinor: bigint;
  /** Warn at or below this. */
  lowBalanceThresholdMinor: bigint;
  /** Deactivate at or below this — normally zero, but configurable per rule. */
  deactivateBelowMinor: bigint;
  /** When the balance first went below the deactivation floor, or null. */
  belowFloorSince: Date | null;
  graceHours: number;
  now: Date;
}

export interface WalletStateResult {
  state: WalletState;
  /** True once the grace period has run out; the shop comes down at this point. */
  shouldDeactivate: boolean;
}

/**
 * A commission charge is applied whether or not the seller can afford it, so the balance can
 * go negative. Refusing the charge would mean the platform silently working for free; taking
 * it and deactivating is the honest outcome, and the grace period is what stops a seller
 * being cut off mid-morning over a few thousand som.
 */
export function evaluateWalletState(inputs: WalletStateInputs): WalletStateResult {
  const belowFloor = inputs.balanceMinor <= inputs.deactivateBelowMinor;

  if (belowFloor) {
    const since = inputs.belowFloorSince ?? inputs.now;
    const elapsedHours = (inputs.now.getTime() - since.getTime()) / (60 * 60 * 1000);
    const graceExpired = elapsedHours >= inputs.graceHours;
    return {
      state: graceExpired ? WalletState.INACTIVE : WalletState.LOW,
      shouldDeactivate: graceExpired,
    };
  }

  if (inputs.balanceMinor <= inputs.lowBalanceThresholdMinor) {
    return { state: WalletState.LOW, shouldDeactivate: false };
  }
  return { state: WalletState.ACTIVE, shouldDeactivate: false };
}

/**
 * Chart of accounts (LEDGER.md).
 *
 * Deliberately tiny. Every movement of money in this system is between exactly two of these,
 * and adding a fifth should require an argument.
 */
export const Account = {
  /** What the platform owes sellers for money they have prepaid. A liability. */
  SELLER_WALLET: 'SELLER_WALLET',
  /** Commission earned. Revenue. */
  PLATFORM_REVENUE_COMMISSION: 'PLATFORM_REVENUE_COMMISSION',
  /** Money actually received. An asset. */
  PLATFORM_CASH: 'PLATFORM_CASH',
  /** Goodwill credits, corrections, write-offs. An expense. */
  PLATFORM_ADJUSTMENT: 'PLATFORM_ADJUSTMENT',
} as const;
export type Account = (typeof Account)[keyof typeof Account];

export const EntrySide = { DEBIT: 'DEBIT', CREDIT: 'CREDIT' } as const;
export type EntrySide = (typeof EntrySide)[keyof typeof EntrySide];

export interface LedgerLine {
  account: Account;
  side: EntrySide;
  amountMinor: bigint;
}

/**
 * The invariant that makes a ledger a ledger: debits equal credits, and nothing is zero.
 *
 * Checked before every write. An unbalanced entry is not a validation failure to be reported
 * to a user — it is a bug in the code that constructed it, and it must never reach storage,
 * because a ledger that does not balance cannot be trusted retrospectively either.
 */
export function assertBalanced(lines: readonly LedgerLine[]): void {
  if (lines.length < 2) {
    throw new Error('A journal entry needs at least two lines');
  }
  let debits = 0n;
  let credits = 0n;
  for (const line of lines) {
    if (line.amountMinor <= 0n) {
      throw new Error('Journal lines must carry a positive amount; direction is the side');
    }
    if (line.side === EntrySide.DEBIT) debits += line.amountMinor;
    else credits += line.amountMinor;
  }
  if (debits !== credits) {
    throw new Error(`Journal entry does not balance: debits ${debits} vs credits ${credits}`);
  }
}

/**
 * The effect of a set of lines on a seller's wallet balance.
 *
 * `SELLER_WALLET` is a liability, so a credit increases what the platform owes the seller —
 * which from the seller's point of view is money they can spend — and a debit reduces it.
 */
export function walletDelta(lines: readonly LedgerLine[]): bigint {
  return lines
    .filter((line) => line.account === Account.SELLER_WALLET)
    .reduce(
      (sum, line) => (line.side === EntrySide.CREDIT ? sum + line.amountMinor : sum - line.amountMinor),
      0n,
    );
}
