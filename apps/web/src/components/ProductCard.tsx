import Link from 'next/link';
import { localized } from '@bozorlar/api-client';
import type { ProductResponse } from '@bozorlar/contracts';
import { Locale } from '@bozorlar/types';
import { PriceBoard } from './PriceBoard';

/**
 * A product as it appears in a stall's list.
 *
 * The price board leads, because that is what a shopper reads first at a bazaar and the only
 * thing on the stall that changed since yesterday. `oldPrice` comes straight from the API, so
 * a genuine drop is shown as a drop rather than as a badge somebody has to interpret.
 *
 * Out of stock does not hide the product. The catalogue deliberately keeps finished goods
 * visible so they can be followed for a restock, and a card that vanished would make the
 * alert that arrives tomorrow inexplicable.
 */
export function ProductCard({ product }: { product: ProductResponse }) {
  const finished = !product.isPurchasable;

  return (
    <Link
      href={`/products/${product.slug}`}
      className="group flex items-start justify-between gap-4 rounded-stall border border-ink/10 bg-white/60 p-4 transition-shadow hover:shadow-lift dark:border-paper/10 dark:bg-paper/5"
    >
      <div className="min-w-0">
        <h3 className="truncate font-display text-base font-medium text-ink group-hover:text-tile dark:text-paper">
          {localized(product.name, Locale.UZ_LATN)}
        </h3>
        <p className="mt-1.5 font-body text-xs text-ink/55 dark:text-paper/55">
          {finished ? (
            <span className="text-pomegranate">Bugun tugagan</span>
          ) : (
            <>
              Qoldiq: {product.availableQty.value} {product.availableQty.unit}
            </>
          )}
        </p>
        {product.rating.count > 0 ? (
          <p className="mt-1 font-body text-xs text-ink/45 dark:text-paper/45">
            {product.rating.avg.toFixed(1)} · {product.rating.count} baho
          </p>
        ) : null}
      </div>

      <PriceBoard
        minor={product.price.amount}
        previousMinor={product.oldPrice?.amount ?? null}
        unit={product.availableQty.unit}
        size="sm"
        className={finished ? 'opacity-55' : undefined}
      />
    </Link>
  );
}
