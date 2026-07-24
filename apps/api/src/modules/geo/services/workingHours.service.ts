import type { Weekday, WorkingHoursEntry } from '@bozorlar/types';

/**
 * Timezone-correct opening-hours evaluation.
 *
 * The naive implementation compares `new Date().getHours()` against the stored time, which is
 * wrong the moment the server runs in UTC — which it always does. Every calculation here is
 * performed in the market's own IANA timezone via Intl, with no external dependency.
 */

export interface OpeningWindow {
  opensAt: Date;
  closesAt: Date;
}

export interface OpeningState {
  isOpenNow: boolean;
  /** Next time the venue opens, or null when it is currently open. */
  opensNextAt: Date | null;
  /** Time the current opening period ends, or null when currently closed. */
  closesAt: Date | null;
}

const MINUTES_PER_DAY = 24 * 60;

export function parseTimeToMinutes(value: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) throw new Error(`Invalid time "${value}"; expected HH:mm`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Local wall-clock parts for an instant, in the given IANA zone. */
function localParts(instant: Date, timezone: string): {
  weekday: Weekday;
  minutes: number;
  year: number;
  month: number;
  day: number;
} {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(instant).map((part) => [part.type, part.value]),
  ) as Record<string, string>;

  const weekdayMap: Record<string, Weekday> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const weekday = weekdayMap[parts.weekday ?? 'Sun'] ?? 0;
  // Intl renders midnight as "24" in some ICU versions; normalise it.
  const hour = Number(parts.hour) % 24;

  return {
    weekday,
    minutes: hour * 60 + Number(parts.minute),
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  };
}

/**
 * Converts a local wall-clock time in `timezone` into an absolute instant.
 *
 * Done by probing: build a UTC guess, measure how far the zone's rendering of that guess
 * drifts from the target, and correct. Two iterations converge even across a DST transition,
 * which matters for portability even though Asia/Tashkent has no DST.
 */
function zonedTimeToInstant(
  parts: { year: number; month: number; day: number },
  minutesOfDay: number,
  timezone: string,
): Date {
  const targetUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    Math.floor(minutesOfDay / 60),
    minutesOfDay % 60,
  );
  let instant = new Date(targetUtc);
  for (let i = 0; i < 2; i += 1) {
    const rendered = localParts(instant, timezone);
    const renderedUtc = Date.UTC(
      rendered.year,
      rendered.month - 1,
      rendered.day,
      Math.floor(rendered.minutes / 60),
      rendered.minutes % 60,
    );
    const drift = targetUtc - renderedUtc;
    if (drift === 0) break;
    instant = new Date(instant.getTime() + drift);
  }
  return instant;
}

function entryFor(hours: readonly WorkingHoursEntry[], weekday: Weekday): WorkingHoursEntry | null {
  return hours.find((entry) => entry.weekday === weekday) ?? null;
}

/**
 * Bazaars routinely open at 06:00 and close at 19:00, but a night market may run 22:00–04:00.
 * A window whose closing time is not after its opening time is therefore treated as spanning
 * midnight rather than as invalid data.
 */
function spansMidnight(entry: WorkingHoursEntry): boolean {
  return parseTimeToMinutes(entry.closesAt) <= parseTimeToMinutes(entry.opensAt);
}

export function evaluateOpening(
  hours: readonly WorkingHoursEntry[],
  timezone: string,
  now: Date = new Date(),
): OpeningState {
  if (hours.length === 0) return { isOpenNow: false, opensNextAt: null, closesAt: null };

  const today = localParts(now, timezone);

  // A window opened yesterday may still be running.
  const yesterdayWeekday = ((today.weekday + 6) % 7) as Weekday;
  const yesterday = entryFor(hours, yesterdayWeekday);
  if (yesterday && !yesterday.isClosed && spansMidnight(yesterday)) {
    const closeMinutes = parseTimeToMinutes(yesterday.closesAt);
    if (today.minutes < closeMinutes) {
      return {
        isOpenNow: true,
        opensNextAt: null,
        closesAt: zonedTimeToInstant(today, closeMinutes, timezone),
      };
    }
  }

  const todayEntry = entryFor(hours, today.weekday);
  if (todayEntry && !todayEntry.isClosed) {
    const openMinutes = parseTimeToMinutes(todayEntry.opensAt);
    const closeMinutes = parseTimeToMinutes(todayEntry.closesAt);
    const effectiveClose = spansMidnight(todayEntry) ? closeMinutes + MINUTES_PER_DAY : closeMinutes;

    if (today.minutes >= openMinutes && today.minutes < effectiveClose) {
      return {
        isOpenNow: true,
        opensNextAt: null,
        closesAt: new Date(
          zonedTimeToInstant(today, openMinutes, timezone).getTime() +
            (effectiveClose - openMinutes) * 60_000,
        ),
      };
    }
    if (today.minutes < openMinutes) {
      return {
        isOpenNow: false,
        opensNextAt: zonedTimeToInstant(today, openMinutes, timezone),
        closesAt: null,
      };
    }
  }

  // Walk forward for the next opening. Seven days is the full cycle; beyond that the venue
  // is closed every day and null is the honest answer.
  for (let offset = 1; offset <= 7; offset += 1) {
    const weekday = ((today.weekday + offset) % 7) as Weekday;
    const entry = entryFor(hours, weekday);
    if (!entry || entry.isClosed) continue;
    const midnight = zonedTimeToInstant(today, 0, timezone);
    const dayStart = new Date(midnight.getTime() + offset * MINUTES_PER_DAY * 60_000);
    const dayParts = localParts(dayStart, timezone);
    return {
      isOpenNow: false,
      opensNextAt: zonedTimeToInstant(dayParts, parseTimeToMinutes(entry.opensAt), timezone),
      closesAt: null,
    };
  }

  return { isOpenNow: false, opensNextAt: null, closesAt: null };
}

/** Validates a full weekly schedule. Called by the service layer before persisting. */
export function assertValidWorkingHours(hours: readonly WorkingHoursEntry[]): void {
  if (hours.length !== 7) {
    throw new Error('Working hours must contain exactly 7 entries, one per weekday');
  }
  const seen = new Set<number>();
  for (const entry of hours) {
    if (seen.has(entry.weekday)) throw new Error(`Duplicate weekday ${entry.weekday}`);
    seen.add(entry.weekday);
    if (!entry.isClosed) {
      parseTimeToMinutes(entry.opensAt);
      parseTimeToMinutes(entry.closesAt);
    }
  }
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
