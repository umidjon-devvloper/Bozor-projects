import { cookies } from 'next/headers';
import type { Locale } from '@bozorlar/types';
import { LOCALE_COOKIE, parseLocale } from './locale';

/** The reader's language during a server render. */
export async function readLocale(): Promise<Locale> {
  const store = await cookies();
  return parseLocale(store.get(LOCALE_COOKIE)?.value);
}
