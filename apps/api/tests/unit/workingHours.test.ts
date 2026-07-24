import { describe, expect, it } from 'vitest';
import {
  assertValidWorkingHours,
  evaluateOpening,
  isValidTimezone,
  parseTimeToMinutes,
} from '../../src/modules/geo/services/workingHours.service.js';
import type { WorkingHoursEntry } from '@bozorlar/types';

const everyDay = (opensAt: string, closesAt: string): WorkingHoursEntry[] =>
  [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday: weekday as WorkingHoursEntry['weekday'],
    opensAt,
    closesAt,
    isClosed: false,
  }));

const TZ = 'Asia/Tashkent'; // UTC+5, no DST

describe('parseTimeToMinutes', () => {
  it('parses valid times', () => {
    expect(parseTimeToMinutes('00:00')).toBe(0);
    expect(parseTimeToMinutes('06:30')).toBe(390);
    expect(parseTimeToMinutes('23:59')).toBe(1439);
  });

  it('rejects malformed input rather than coercing it', () => {
    expect(() => parseTimeToMinutes('24:00')).toThrow();
    expect(() => parseTimeToMinutes('6:00')).toThrow();
    expect(() => parseTimeToMinutes('')).toThrow();
  });
});

describe('evaluateOpening', () => {
  it('evaluates in the market timezone, not the server timezone', () => {
    // 08:00 UTC is 13:00 in Tashkent, which is inside 06:00-19:00.
    // A naive server-clock implementation running in UTC would report the market as open at
    // 02:00 UTC (07:00 local) but *also* at 18:00 UTC (23:00 local). This asserts both.
    const hours = everyDay('06:00', '19:00');
    expect(evaluateOpening(hours, TZ, new Date('2026-07-23T08:00:00Z')).isOpenNow).toBe(true);
    expect(evaluateOpening(hours, TZ, new Date('2026-07-23T18:00:00Z')).isOpenNow).toBe(false);
  });

  it('reports the next opening when currently closed', () => {
    const hours = everyDay('06:00', '19:00');
    // 20:00 UTC on 23 July = 01:00 local on 24 July -> opens at 06:00 local the same day.
    const state = evaluateOpening(hours, TZ, new Date('2026-07-23T20:00:00Z'));
    expect(state.isOpenNow).toBe(false);
    expect(state.opensNextAt?.toISOString()).toBe('2026-07-24T01:00:00.000Z');
  });

  it('handles a window that spans midnight', () => {
    const hours = everyDay('22:00', '04:00');
    // 22:00 UTC = 03:00 local, still inside the window opened the previous evening.
    expect(evaluateOpening(hours, TZ, new Date('2026-07-23T22:00:00Z')).isOpenNow).toBe(true);
    // 06:00 UTC = 11:00 local, well outside it.
    expect(evaluateOpening(hours, TZ, new Date('2026-07-23T06:00:00Z')).isOpenNow).toBe(false);
  });

  it('skips closed days when looking ahead', () => {
    const hours = everyDay('06:00', '19:00').map((entry) =>
      entry.weekday === 5 ? { ...entry, isClosed: true } : entry,
    );
    // Thursday 23 July 2026 at 20:00 local -> Friday is closed, so next opening is Saturday.
    const state = evaluateOpening(hours, TZ, new Date('2026-07-23T15:00:00Z'));
    expect(state.isOpenNow).toBe(false);
    expect(state.opensNextAt?.toISOString()).toBe('2026-07-25T01:00:00.000Z');
  });

  it('returns closed with no next opening when every day is closed', () => {
    const hours = everyDay('06:00', '19:00').map((entry) => ({ ...entry, isClosed: true }));
    const state = evaluateOpening(hours, TZ, new Date('2026-07-23T08:00:00Z'));
    expect(state).toEqual({ isOpenNow: false, opensNextAt: null, closesAt: null });
  });

  it('works in a zone with DST, not only in UTC+5', () => {
    const hours = everyDay('09:00', '17:00');
    // 2026-07-23 is inside British Summer Time (UTC+1); 10:00 UTC is 11:00 local.
    expect(evaluateOpening(hours, 'Europe/London', new Date('2026-07-23T10:00:00Z')).isOpenNow).toBe(true);
    // 17:30 UTC is 18:30 local, after closing.
    expect(evaluateOpening(hours, 'Europe/London', new Date('2026-07-23T17:30:00Z')).isOpenNow).toBe(false);
  });
});

describe('assertValidWorkingHours', () => {
  it('requires exactly seven unique weekdays', () => {
    expect(() => assertValidWorkingHours(everyDay('06:00', '19:00'))).not.toThrow();
    expect(() => assertValidWorkingHours(everyDay('06:00', '19:00').slice(0, 6))).toThrow();
    const duplicated = everyDay('06:00', '19:00');
    duplicated[6] = { ...duplicated[0]! };
    expect(() => assertValidWorkingHours(duplicated)).toThrow(/Duplicate/);
  });

  it('does not validate times on closed days', () => {
    const hours = everyDay('06:00', '19:00').map((entry) =>
      entry.weekday === 0 ? { ...entry, isClosed: true, opensAt: '', closesAt: '' } : entry,
    );
    expect(() => assertValidWorkingHours(hours)).not.toThrow();
  });
});

describe('isValidTimezone', () => {
  it('accepts IANA zones and rejects anything else', () => {
    expect(isValidTimezone('Asia/Tashkent')).toBe(true);
    expect(isValidTimezone('Not/AZone')).toBe(false);
  });
});
