'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from '@bozorlar/session';

/** Three destinations: the queue, the goods, the money. Nothing else is a daily job. */
export function SellerHeader() {
  const pathname = usePathname();
  const { status, signOut } = useSession();

  return (
    <header className="sticky top-0 z-10 border-b border-ink/10 bg-paper/90 backdrop-blur dark:border-paper/10 dark:bg-ink/90">
      <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-4 px-5 py-3 sm:px-8">
        <Link href="/" className="font-display text-base font-bold text-ink dark:text-paper">
          Kabinet
        </Link>

        {status === 'signed-in' ? (
          <nav className="flex items-center gap-1 font-body text-sm">
            <Tab href="/" active={pathname === '/'}>Buyurtmalar</Tab>
            <Tab href="/mahsulotlar" active={pathname.startsWith('/mahsulotlar')}>Mahsulotlar</Tab>
            <Tab href="/hisob" active={pathname.startsWith('/hisob')}>Hisob</Tab>
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
          ? 'rounded-stall px-2 py-1.5 text-saffron-deep dark:text-saffron'
          : 'rounded-stall px-2 py-1.5 text-ink/70 hover:text-saffron-deep dark:text-paper/70'
      }
    >
      {children}
    </Link>
  );
}
