'use client';

import { useEffect, useState } from 'react';
import { Locale } from '@bozorlar/types';
import { LOCALE_COOKIE, LOCALE_LABEL } from '@/lib/locale';
import { THEME_COOKIE, type Theme } from '@/lib/theme';

function writeCookie(name: string, value: string): void {
  // A year, site-wide, and Lax: this travels on ordinary navigation and nothing else.
  document.cookie = `${name}=${value}; path=/; max-age=31536000; samesite=lax`;
}

/**
 * Language and theme, together, because they are the same kind of decision: how the page should
 * look to this reader, made once and remembered.
 *
 * Changing the language reloads rather than re-rendering. The catalogue is localised on the
 * server from `Accept-Language`, so every product name on screen came from the API in the old
 * language — a client-side switch would translate the interface and leave the goods untranslated,
 * which is worse than a reload.
 */
export function Preferences({ locale }: { locale: Locale }) {
  const [theme, setTheme] = useState<Theme>('light');

  useEffect(() => {
    setTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light');
  }, []);

  function toggleTheme(): void {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.classList.toggle('dark', next === 'dark');
    writeCookie(THEME_COOKIE, next);
    setTheme(next);
  }

  function changeLocale(next: string): void {
    writeCookie(LOCALE_COOKIE, next);
    window.location.reload();
  }

  return (
    <div className="flex items-center gap-1">
      <label className="sr-only" htmlFor="locale">
        Til
      </label>
      <select
        id="locale"
        value={locale}
        onChange={(event) => changeLocale(event.target.value)}
        className="rounded-stall bg-transparent px-1.5 py-1.5 font-body text-sm text-ink/70 hover:text-tile dark:text-paper/70"
      >
        {Object.values(Locale).map((value) => (
          <option key={value} value={value}>
            {LOCALE_LABEL[value]}
          </option>
        ))}
      </select>

      <button
        type="button"
        onClick={toggleTheme}
        aria-label={theme === 'dark' ? "Yorug' rejimga o'tish" : "Qorong'i rejimga o'tish"}
        className="rounded-stall px-2 py-1.5 font-body text-sm text-ink/70 hover:text-tile dark:text-paper/70"
      >
        {theme === 'dark' ? '☀' : '☾'}
      </button>
    </div>
  );
}
