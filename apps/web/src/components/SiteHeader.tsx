'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import type { Locale } from '@bozorlar/types';
import { Preferences } from './Preferences';
import { useApi, useSession } from '@bozorlar/session';

/**
 * The one persistent piece of navigation.
 *
 * Deliberately three destinations and no menu. A shopper on a mid-range phone at a bazaar has
 * one hand free; anything behind a hamburger is a tap they will not make. The basket count is
 * the only live figure here because it is the only one that changes while they browse.
 */
export function SiteHeader({ locale }: { locale: Locale }) {
  const api = useApi();
  const { status } = useSession();
  const pathname = usePathname();

  const cart = useQuery({
    queryKey: ['cart'],
    queryFn: () => api.cart.get().then((response) => response.data),
    enabled: status === 'signed-in',
  });

  const count = cart.data?.itemCount ?? 0;

  return (
    <header className="sticky top-0 z-10 border-b border-ink/10 bg-paper/85 backdrop-blur dark:border-paper/10 dark:bg-ink/85">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-5 py-3 sm:px-8">
        <Link href="/" className="font-display text-base font-bold tracking-tight text-ink dark:text-paper">
          Bozorlar
        </Link>

        <nav className="flex items-center gap-1 font-body text-sm">
          <NavLink href="/qidiruv" active={pathname === '/qidiruv'}>
            Qidirish
          </NavLink>
          <Preferences locale={locale} />
          <NavLink href="/savat" active={pathname === '/savat'}>
            Savat
            {count > 0 ? (
              <span className="ml-1.5 rounded-full bg-tile px-1.5 py-0.5 text-[0.6875rem] tabular-nums text-paper">
                {count}
              </span>
            ) : null}
          </NavLink>

          {status === 'signed-in' ? (
            <>
              <NavLink href="/buyurtmalarim" active={pathname.startsWith('/buyurtmalarim')}>
                Buyurtmalarim
              </NavLink>
              <NavLink href="/profil" active={pathname === '/profil'}>
                Profil
              </NavLink>
            </>
          ) : (
            <NavLink href="/kirish" active={pathname === '/kirish'}>
              Kirish
            </NavLink>
          )}
        </nav>
      </div>
    </header>
  );
}

function NavLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={
        active
          ? 'rounded-stall px-2 py-1.5 text-tile dark:text-tile-light'
          : 'rounded-stall px-2 py-1.5 text-ink/70 hover:text-tile dark:text-paper/70'
      }
    >
      {children}
    </Link>
  );
}
