import type { Locale } from '@bozorlar/types';

/**
 * Turning API values into something a person reads.
 *
 * Money arrives as a decimal string of tiyin (ADR-0028) and must never become a JS number on
 * the way to the screen. `Number('9007199254740993')` is already wrong, and a marketplace that
 * displays a price the checkout then disagrees with has lost the argument before it starts.
 * These functions work on the string.
 */

/**
 * Tiyin to som, grouped the way a price is written on a stall board: `12 500`.
 *
 * A narrow no-break space, not a comma — a comma reads as a decimal separator across the whole
 * region, and `12,500` for twelve and a half thousand som is a genuine misreading, not a
 * stylistic quibble.
 */
export function formatSom(minor: string | bigint | null | undefined): string {
  if (minor === null || minor === undefined) return '—';
  const value = typeof minor === 'bigint' ? minor : BigInt(minor);
  const som = value / 100n;
  const tiyin = value % 100n;
  const grouped = som.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '\u202F');
  return tiyin === 0n ? grouped : `${grouped},${tiyin.toString().padStart(2, '0')}`;
}

/** Quantity arrives in thousandths. Trailing zeros are noise on a price tag. */
export function formatQuantity(milli: string | bigint | null | undefined, unit: string): string {
  if (milli === null || milli === undefined) return '—';
  const value = typeof milli === 'bigint' ? milli : BigInt(milli);
  const whole = value / 1000n;
  const fraction = (value % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return fraction ? `${whole},${fraction} ${unit}` : `${whole} ${unit}`;
}

/**
 * Which key of a `LocalizedText` a locale reads from.
 *
 * The two vocabularies genuinely differ and it is not a mistake in either: `Locale` is a BCP-47
 * tag because it goes in `Accept-Language`, while `LocalizedText` keys are field names in a
 * Mongo document, where a hyphen is awkward. Indexing the document with the tag silently misses
 * for every Uzbek reader — the majority of the audience — and falls back to the default without
 * anything looking broken. The map is the fix, and it exists so nobody has to remember.
 */
const LOCALE_FIELD: Readonly<Record<Locale, string>> = {
  'uz-Latn': 'uz',
  'uz-Cyrl': 'uzCyrl',
  ru: 'ru',
  en: 'en',
};

/**
 * Picks a language out of a `LocalizedText`.
 *
 * Falls back through Uzbek Latin rather than to an empty string, because the fallback is a
 * seller's own words for their own product. A blank name is worse than the wrong alphabet.
 */
export function localized(
  text: Partial<Record<string, string>> | string | null | undefined,
  locale: Locale,
): string {
  if (!text) return '';
  if (typeof text === 'string') return text;
  const values = Object.values(text).filter((value): value is string => Boolean(value));
  return text[LOCALE_FIELD[locale]] ?? text.uz ?? values[0] ?? '';
}
