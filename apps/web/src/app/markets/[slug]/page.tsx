import { notFound } from 'next/navigation';
import { localized } from '@bozorlar/api-client';
import { Locale } from '@bozorlar/types';
import { api } from '@/lib/api';
import { StallCard } from '@/components/StallCard';

export const revalidate = 60;

/**
 * A market: which stalls are open right now.
 *
 * Open stalls come first and shut ones stay listed rather than being filtered out — a shopper
 * planning tomorrow morning still wants to know the stall exists and where it is. The sort is
 * done here rather than asked of the API because "open" is a computed field that changes by the
 * minute and is not something to page on.
 */
export default async function MarketPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const market = await api.markets
    .get(slug)
    .then((response) => response.data)
    .catch(() => null);
  if (!market) notFound();

  const shops = await api.shops
    .inMarket(market.id, { limit: 60 })
    .then((response) => response.data)
    .catch(() => []);

  const sorted = [...shops].sort((a, b) => Number(b.isOpenNow) - Number(a.isOpenNow));
  const marketName = localized(market.name, Locale.UZ_LATN);
  const openCount = shops.filter((shop) => shop.isOpenNow).length;

  return (
    <main className="mx-auto w-full max-w-5xl px-5 pb-24 pt-10 sm:px-8">
      <nav className="mb-8 font-body text-xs text-ink/50 dark:text-paper/50">
        <a href="/" className="hover:text-tile">
          Bosh sahifa
        </a>
        <span className="px-1.5 text-saffron">·</span>
        <span>{marketName}</span>
      </nav>

      <header className="mb-10">
        <h1 className="font-display text-3xl font-bold leading-tight text-ink sm:text-4xl dark:text-paper">
          {marketName}
        </h1>
        <p className="mt-3 max-w-xl font-body text-sm leading-relaxed text-ink/65 dark:text-paper/65">
          {localized(market.address, Locale.UZ_LATN)}
        </p>
        <p className="mt-4 font-body text-sm text-ink/70 dark:text-paper/70">
          {market.isOpenNow ? (
            <>
              Hozir ochiq — <span className="text-tile">{openCount} do'kon</span> ish
              yuritmoqda
            </>
          ) : (
            <>Hozir yopiq</>
          )}
        </p>
      </header>

      <section aria-labelledby="stalls-heading">
        <h2 id="stalls-heading" className="mb-5 font-display text-lg font-medium text-ink dark:text-paper">
          Do'konlar
        </h2>

        {sorted.length === 0 ? (
          <p className="rounded-stall border border-dashed border-ink/20 px-6 py-12 text-center font-body text-sm text-ink/60 dark:border-paper/20 dark:text-paper/60">
            Bu bozorda hali do'kon ro'yxatdan o'tmagan.
          </p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {sorted.map((shop) => (
              <li key={shop.id}>
                <StallCard shop={shop} marketName={marketName} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
