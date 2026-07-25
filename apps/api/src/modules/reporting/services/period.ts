import { validationFailed } from '@bozorlar/errors';
import { MAX_REPORT_DAYS } from '../reporting.constants.js';

/**
 * A half-open reporting window: `[from, to)`.
 *
 * Half-open on purpose. A closed range makes the caller decide whether `to` means "up to
 * midnight" or "up to the last millisecond of the day", and the two answers differ by exactly
 * one day of orders. Adjacent periods computed this way also tile without overlapping, so a
 * month of daily reports sums to the monthly report — which is the property that makes a
 * statement checkable.
 */
export interface ReportPeriod {
  from: Date;
  to: Date;
  days: number;
}

const MS_PER_DAY = 86_400_000;

export function resolvePeriod(input: { from?: string; to?: string }, now: Date): ReportPeriod {
  const to = input.to ? new Date(input.to) : now;
  const from = input.from ? new Date(input.from) : new Date(to.getTime() - 30 * MS_PER_DAY);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw validationFailed(
      [{ field: 'from', code: 'INVALID_DATE' }],
      'from and to must be valid dates',
    );
  }
  if (from >= to) {
    throw validationFailed(
      [{ field: 'from', code: 'RANGE_INVERTED' }],
      'from must be earlier than to',
    );
  }

  const days = Math.ceil((to.getTime() - from.getTime()) / MS_PER_DAY);
  if (days > MAX_REPORT_DAYS) {
    throw validationFailed(
      [{ field: 'from', code: 'RANGE_TOO_LONG', params: { max: MAX_REPORT_DAYS, asked: days } }],
      `A report may cover at most ${MAX_REPORT_DAYS} days; asked for ${days}`,
    );
  }

  return { from, to, days };
}

/** The window immediately before this one, of equal length — for period-on-period deltas. */
export function previousPeriod(period: ReportPeriod): ReportPeriod {
  const span = period.to.getTime() - period.from.getTime();
  return {
    from: new Date(period.from.getTime() - span),
    to: new Date(period.from.getTime()),
    days: period.days,
  };
}

/**
 * Percentage change, in basis points, or null when there is nothing to compare against.
 *
 * Null rather than zero or 100%: a seller's first month has no previous month, and reporting
 * "+100%" for it would be a fabricated number that looks like a fact.
 */
export function changeBp(current: bigint, previous: bigint): number | null {
  if (previous === 0n) return null;
  const delta = current - previous;
  return Number((delta * 10_000n) / previous);
}
