import { Account, EntrySide } from '@bozorlar/domain';

/**
 * Turning journal lines into a statement.
 *
 * Kept pure and separate from the aggregation for one reason: this is the arithmetic a seller
 * will check against their own notes, and if it is wrong they will not trust anything else the
 * platform tells them. It needs to be readable and exhaustively testable without a database.
 *
 * Commission is read from the ledger rather than from `orders.commission.amount`, and the
 * distinction matters. The order records what was *meant* to be charged; the journal records
 * what was actually posted. They diverge exactly when something went wrong — a charge that
 * failed for a missing rule, a reversal after a dispute — and those are the cases a statement
 * exists to show.
 */

export interface StatementLine {
  account: Account;
  side: EntrySide;
  amountMinor: bigint;
}

export interface Statement {
  /** Commission posted against the seller in the period. */
  commissionChargedMinor: bigint;
  /** Commission given back — dispute refunds, corrections. */
  commissionReversedMinor: bigint;
  /** What the seller actually owed for the period. */
  commissionNetMinor: bigint;
  /** Money the seller put into their wallet in the period. */
  topUpMinor: bigint;
  /** Goodwill credits and manual corrections, netted. */
  adjustmentMinor: bigint;
}

const ZERO: Statement = {
  commissionChargedMinor: 0n,
  commissionReversedMinor: 0n,
  commissionNetMinor: 0n,
  topUpMinor: 0n,
  adjustmentMinor: 0n,
};

/**
 * Sums journal lines into a statement.
 *
 * Signs follow double-entry rather than intuition, so they are worth stating. Commission
 * revenue is a credit to `PLATFORM_REVENUE_COMMISSION`; a reversal is a debit to the same
 * account. Netting them by side is therefore the whole of the commission arithmetic, and a
 * reversal can never be double-counted as a charge no matter what order the lines arrive in.
 */
export function summarise(lines: readonly StatementLine[]): Statement {
  const out: Statement = { ...ZERO };

  for (const line of lines) {
    switch (line.account) {
      case Account.PLATFORM_REVENUE_COMMISSION:
        if (line.side === EntrySide.CREDIT) {
          out.commissionChargedMinor += line.amountMinor;
        } else {
          out.commissionReversedMinor += line.amountMinor;
        }
        break;
      case Account.PLATFORM_CASH:
        // Cash in is a debit to the asset: the seller paid money to the platform.
        if (line.side === EntrySide.DEBIT) out.topUpMinor += line.amountMinor;
        break;
      case Account.PLATFORM_ADJUSTMENT:
        // An expense to the platform is a credit to the seller, so it counts positively here.
        out.adjustmentMinor +=
          line.side === EntrySide.DEBIT ? line.amountMinor : -line.amountMinor;
        break;
      case Account.SELLER_WALLET:
        // The mirror side of every movement above; counting it would double every figure.
        break;
    }
  }

  out.commissionNetMinor = out.commissionChargedMinor - out.commissionReversedMinor;
  return out;
}

/**
 * The rate the seller actually paid, in basis points.
 *
 * Reported against realised sales rather than against the configured rule, because the two
 * differ whenever a charge failed or was reversed — and the effective rate is the number a
 * seller can check against their own takings.
 */
export function effectiveRateBp(commissionNetMinor: bigint, gmvMinor: bigint): number | null {
  if (gmvMinor <= 0n) return null;
  return Number((commissionNetMinor * 10_000n) / gmvMinor);
}
