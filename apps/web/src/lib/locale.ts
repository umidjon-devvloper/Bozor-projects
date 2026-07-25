import { Locale } from '@bozorlar/types';

/**
 * The reader's language, kept in a plain cookie.
 *
 * A cookie rather than a URL segment or `localStorage`: the server renders the catalogue and
 * needs the language before any script runs, and a `/ru/...` prefix would fork every route for
 * a choice that is not part of the address. It is readable on purpose — a language preference
 * is not a secret, and making it httpOnly would keep the client from reading its own setting.
 */
export const LOCALE_COOKIE = 'bozorlar_locale';

export const LOCALE_LABEL: Readonly<Record<Locale, string>> = {
  [Locale.UZ_LATN]: "O'zbekcha",
  [Locale.UZ_CYRL]: 'Ўзбекча',
  [Locale.RU]: 'Русский',
  [Locale.EN]: 'English',
};

/** Falls back to Uzbek Latin, which is what the catalogue is written in. */
export function parseLocale(value: string | undefined): Locale {
  const known = Object.values(Locale) as string[];
  return known.includes(value ?? '') ? (value as Locale) : Locale.UZ_LATN;
}
