'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from '@bozorlar/session';

export function AdminHeader() {
  const pathname = usePathname();
  const { status, signOut } = useSession();

  return (
    <header className="sticky top-0 z-10 border-b border-ink/10 bg-paper/90 backdrop-blur dark:border-paper/10 dark:bg-ink/90">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-5 py-3 sm:px-8">
        <Link href="/" className="font-display text-base font-bold text-ink dark:text-paper">
          Administrator
        </Link>

        {status === 'signed-in' ? (
          <nav className="flex items-center gap-1 font-body text-sm">
            <Tab href="/" active={pathname === '/'}>Ko'rsatkichlar</Tab>
            <Tab href="/navbatlar" active={pathname.startsWith('/navbatlar')}>Navbatlar</Tab>
            <Tab href="/dokonlar" active={pathname.startsWith('/dokonlar')}>Do'konlar</Tab>
            <Tab href="/komissiya" active={pathname.startsWith('/komissiya')}>Komissiya</Tab>
            <button
              type="button"
              onClick={() => void signOut()}
              className="ml-1 px-2 py-1.5 text-ink/50 hover:text-pomegranate dark:text-paper/50"
            >
              Chiqish
            </button>
          </nav>
        ) : null}
      </div>
    </header>
  );
}

function Tab({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
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
