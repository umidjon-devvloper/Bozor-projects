import { notFound } from 'next/navigation';
import { localized } from '@bozorlar/api-client';
import { Locale } from '@bozorlar/types';
import { api } from '@/lib/api';
import { ProductCard } from '@/components/ProductCard';
import { StallAddress } from '@/components/PriceBoard';

export const revalidate = 60;

/**
 * A stall and what is on it today.
 *
 * Purchasable goods lead and finished ones fall to the bottom rather than disappearing: a
 * shopper who came for tomatoes that sold out this morning needs to see that they exist here,
 * so they can follow the product instead of walking to another row.
 */
export default async function ShopPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const shop = await api.shops
    .get(slug)
    .then((response) => response.data)
    .catch(() => null);
  if (!shop) notFound();

  const [market, products] = await Promise.all([
    api.markets
      .get(shop.marketId)
      .then((response) => response.data)
      .catch(() => null),
    api.products
      .list({ shopId: shop.id, limit: 60 })
      .then((response) => response.data)
      .catch(() => []),
  ]);

  const sorted = [...products].sort((a, b) => Number(b.isPurchasable) - Number(a.isPurchasable));
  const marketName = market ? localized(market.name, Locale.UZ_LATN) : '';

  return (
    <main className="mx-auto w-full max-w-4xl px-5 pb-24 pt-10 sm:px-8">
      <nav className="mb-8 font-body text-xs text-ink/50 dark:text-paper/50">
        <a href="/" className="hover:text-tile">
          Bosh sahifa
        </a>
        {market ? (
          <>
            <span className="px-1.5 text-saffron">·</span>
            <a href={`/markets/${market.slug}`} className="hover:text-tile">
              {marketName}
            </a>
          </>
        ) : null}
      </nav>

      <header className="mb-10 border-b border-ink/10 pb-8 dark:border-paper/10">
        <span className="flex items-center gap-2">
          <span
            aria-hidden
            className={
              shop.isOpenNow
                ? 'h-1.5 w-1.5 rounded-full bg-tile'
                : 'h-1.5 w-1.5 rounded-full bg-ink/25 dark:bg-paper/25'
            }
          />
          <span className="font-body text-[0.6875rem] uppercase tracking-wider text-ink/50 dark:text-paper/50">
            {shop.isOpenNow ? 'Hozir ochiq' : 'Hozir yopiq'}
          </span>
        </span>

        <h1 className="mt-3 font-display text-3xl font-bold leading-tight text-ink dark:text-paper">
          {localized(shop.name, Locale.UZ_LATN)}
        </h1>
        <StallAddress
          className="mt-2 text-sm"
          market={marketName}
          section={shop.sectionCode}
          stall={shop.stallNo}
        />

        <dl className="mt-6 flex flex-wrap gap-x-8 gap-y-3 font-body text-sm">
          <div>
            <dt className="text-xs text-ink/45 dark:text-paper/45">Mahsulot</dt>
            <dd className="mt-0.5 text-ink dark:text-paper">{shop.productCount}</dd>
          </div>
          {shop.rating.count > 0 ? (
            <div>
              <dt className="text-xs text-ink/45 dark:text-paper/45">Baho</dt>
              <dd className="mt-0.5 text-ink dark:text-paper">
                {shop.rating.avg.toFixed(1)} · {shop.rating.count} ta
              </dd>
            </div>
          ) : null}
          <div>
            <dt className="text-xs text-ink/45 dark:text-paper/45">Telefon</dt>
            <dd className="mt-0.5 text-ink dark:text-paper">{shop.contactPhone}</dd>
          </div>
        </dl>
      </header>

      <section aria-labelledby="goods-heading">
        <h2 id="goods-heading" className="mb-5 font-display text-lg font-medium text-ink dark:text-paper">
          Bugungi mahsulotlar
        </h2>

        {sorted.length === 0 ? (
          <p className="rounded-stall border border-dashed border-ink/20 px-6 py-12 text-center font-body text-sm text-ink/60 dark:border-paper/20 dark:text-paper/60">
            Bu do'konda hozircha mahsulot yo'q.
          </p>
        ) : (
          <ul className="grid gap-3">
            {sorted.map((product) => (
              <li key={product.id}>
                <ProductCard product={product} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
