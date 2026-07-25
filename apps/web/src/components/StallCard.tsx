import Link from 'next/link';
import { localized } from '@bozorlar/api-client';
import type { ShopResponse } from '@bozorlar/contracts';
import { Locale } from '@bozorlar/types';
import { StallAddress } from './PriceBoard';

/** A stall in a market listing. Open-or-shut leads; the name is supporting detail. */
export function StallCard({ shop, marketName }: { shop: ShopResponse; marketName: string }) {
  return (
    <Link
      href={`/shops/${shop.slug}`}
      className="group block rounded-stall border border-ink/10 bg-white/60 p-4 transition-shadow hover:shadow-lift dark:border-paper/10 dark:bg-paper/5"
    >
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
          {shop.isOpenNow ? 'Ochiq' : 'Yopiq'}
        </span>
      </span>

      <h3 className="mt-2 font-display text-base font-medium text-ink group-hover:text-tile dark:text-paper">
        {localized(shop.name, Locale.UZ_LATN)}
      </h3>
      <StallAddress className="mt-1" market={marketName} section={shop.sectionCode} stall={shop.stallNo} />
      <p className="mt-3 font-body text-xs text-ink/45 dark:text-paper/45">
        {shop.productCount} mahsulot
        {shop.rating.count > 0 ? ` · ${shop.rating.avg.toFixed(1)} (${shop.rating.count})` : ''}
      </p>
    </Link>
  );
}
