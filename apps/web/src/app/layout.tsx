import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Providers } from './providers';
import { SiteHeader } from '@/components/SiteHeader';
import { readLocale } from '@/lib/serverLocale';
import { THEME_INIT_SCRIPT } from '@/lib/theme';
import './globals.css';

export const metadata: Metadata = {
  title: "Bozorlar — respublika bozorlari",
  description:
    "Chorsu, Alay va boshqa bozorlardagi do'konlar: bugungi narxlar, bor-yo'g'i va olib ketish.",
};

/**
 * Fonts are loaded with a stylesheet link rather than `next/font`.
 *
 * Both faces carry full Cyrillic, which is not a preference here: the same catalogue is read in
 * Uzbek Latin, Uzbek Cyrillic and Russian, and a display face without Cyrillic would silently
 * fall back to a system font for a large share of the audience — the one place a type choice
 * stops being a type choice and becomes a bug.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await readLocale();

  return (
    <html lang={locale}>
      <head>
        {/* Applied before first paint so a dark reader never sees a white flash. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Onest:wght@400;500;600&family=Unbounded:wght@500;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <Providers locale={locale}>
          <SiteHeader locale={locale} />
          {children}
        </Providers>
      </body>
    </html>
  );
}
