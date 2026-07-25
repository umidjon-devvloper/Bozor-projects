import Link from 'next/link';
import { localized } from '@bozorlar/api-client';
import { Locale } from '@bozorlar/types';
import type { MarketResponse } from '@bozorlar/contracts';
import { api } from '@/lib/api';
import { PriceBoard, StallAddress } from '@/components/PriceBoard';

export const revalidate = 60;

/**
 * The front page answers one question: which bazaar, and what is worth walking to today.
 *
 * It is not a product grid. A shopper here already knows the bazaars — they have been to
 * Chorsu — so the first choice is spatial, and the page opens by asking which market rather
 * than by selling them something. Everything below that choice is stalls and today's chalked
 * prices, which is what a person actually walks in reading.
 */
export default async function HomePage() {
  const markets = await api.markets
    .list({ limit: 12 })
    .then((response) => response.data)
    .catch(() => [] as MarketResponse[]);

  return (
    <main className="mx-auto w-full max-w-5xl px-5 pb-24 pt-10 sm:px-8">
      <header className="mb-12">
        <p className="mb-3 font-body text-xs uppercase tracking-[0.2em] text-tile">
          Respublika bozorlari
        </p>
        <h1 className="max-w-2xl font-display text-3xl font-bold leading-[1.15] text-ink sm:text-5xl dark:text-paper">
          Bugun bozorda nima bor,
          <br />
          <span className="text-tile dark:text-tile-light">qanchadan</span>.
        </h1>
        <p className="mt-5 max-w-lg font-body text-base leading-relaxed text-ink/70 dark:text-paper/70">
          Do'konlarning bugungi narxlari va qoldig'i. Buyurtma berasiz, o'zingiz borib olasiz —
          rastani qidirib yurmaysiz.
        </p>
      </header>

      <section aria-labelledby="markets-heading">
        <div className="mb-5 flex items-baseline justify-between gap-4">
          <h2
            id="markets-heading"
            className="font-display text-lg font-medium text-ink dark:text-paper"
          >
            Bozorni tanlang
          </h2>
          <span className="font-body text-xs text-ink/50 dark:text-paper/50">
            {markets.length} ta bozor
          </span>
        </div>

        {markets.length === 0 ? (
          <EmptyMarkets />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {markets.map((market) => (
              <li key={market.id}>
                <MarketCard market={market} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-16" aria-labelledby="board-heading">
        <h2
          id="board-heading"
          className="mb-5 font-display text-lg font-medium text-ink dark:text-paper"
        >
          Narx taxtasi
        </h2>
        <p className="mb-6 max-w-lg font-body text-sm leading-relaxed text-ink/60 dark:text-paper/60">
          Bozorda narx bo'r bilan yoziladi va kun davomida o'chirilib qayta yoziladi. Bu yerda
          ham shunday: tushgan narx eski raqami bilan ko'rinadi.
        </p>
        <div className="flex flex-wrap items-end gap-4">
          <PriceBoard minor="1250000" unit="kg" size="lg" />
          <PriceBoard minor="880000" previousMinor="1100000" unit="kg" />
          <PriceBoard minor="4500000" unit="quti" size="sm" />
        </div>
        <StallAddress
          className="mt-4"
          market="Chorsu bozori"
          section="Sabzavot rastasi"
          stall="14"
        />
      </section>
    </main>
  );
}

/**
 * Whether the bazaar is open is the first thing worth knowing about it — these close, and a
 * shopper who drives to a shut market will not use the site again. It leads, before the name's
 * own supporting detail.
 */
function MarketCard({ market }: { market: MarketResponse }) {
  return (
    <Link
      href={`/markets/${market.slug}`}
      className="group block rounded-stall border border-ink/10 bg-white/60 p-4 transition-shadow hover:shadow-lift dark:border-paper/10 dark:bg-paper/5"
    >
      <span className="flex items-center gap-2">
        <span
          aria-hidden
          className={
            market.isOpenNow
              ? 'h-1.5 w-1.5 rounded-full bg-tile'
              : 'h-1.5 w-1.5 rounded-full bg-ink/25 dark:bg-paper/25'
          }
        />
        <span className="font-body text-[0.6875rem] uppercase tracking-wider text-ink/50 dark:text-paper/50">
          {market.isOpenNow ? 'Ochiq' : 'Yopiq'}
        </span>
      </span>

      <h3 className="mt-2 font-display text-base font-medium text-ink group-hover:text-tile dark:text-paper">
        {localized(market.name, Locale.UZ_LATN)}
      </h3>
      <p className="mt-1 font-body text-xs leading-relaxed text-ink/55 dark:text-paper/55">
        {localized(market.address, Locale.UZ_LATN)}
      </p>
      <p className="mt-3 font-body text-xs text-ink/45 dark:text-paper/45">
        {market.shopCount} do'kon · {market.productCount} mahsulot
      </p>
    </Link>
  );
}

/**
 * An empty screen is an invitation, and here it is also the honest state before seeding: the
 * API is reachable but has no markets yet. Saying so beats a spinner that never resolves.
 */
function EmptyMarkets() {
  return (
    <div className="rounded-stall border border-dashed border-ink/20 px-6 py-12 text-center dark:border-paper/20">
      <p className="font-display text-base text-ink dark:text-paper">Hozircha bozor yo'q</p>
      <p className="mx-auto mt-2 max-w-sm font-body text-sm text-ink/60 dark:text-paper/60">
        Bozorlar qo'shilgach shu yerda chiqadi. Agar bu kutilmagan bo'lsa, API ishlab turganini
        tekshiring.
      </p>
    </div>
  );
}
