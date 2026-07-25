import { notFound } from 'next/navigation';
import { formatQuantity, localized } from '@bozorlar/api-client';
import { Locale } from '@bozorlar/types';
import { api } from '@/lib/api';
import { PriceBoard } from '@/components/PriceBoard';
import { AddToCart } from '@/components/AddToCart';

export const revalidate = 60;

/**
 * One product, at one stall.
 *
 * The page has to answer three questions in order: what does it cost today, can I get it now,
 * and how much am I obliged to buy. The last one is not a detail at a bazaar — produce is sold
 * by the kilo in steps, and a shopper who adds 300 grams to a basket that only sells in
 * half-kilos should learn that here rather than at checkout.
 */
export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const product = await api.products
    .get(slug)
    .then((response) => response.data)
    .catch(() => null);
  if (!product) notFound();

  const unit = product.availableQty.unit;
  const dropped = product.oldPrice != null;

  return (
    <main className="mx-auto w-full max-w-3xl px-5 pb-24 pt-10 sm:px-8">
      <nav className="mb-8 font-body text-xs text-ink/50 dark:text-paper/50">
        <a href="/" className="hover:text-tile">
          Bosh sahifa
        </a>
      </nav>

      <header className="mb-8">
        <h1 className="font-display text-3xl font-bold leading-tight text-ink sm:text-4xl dark:text-paper">
          {localized(product.name, Locale.UZ_LATN)}
        </h1>
        {product.rating.count > 0 ? (
          <p className="mt-3 font-body text-sm text-ink/60 dark:text-paper/60">
            {product.rating.avg.toFixed(1)} · {product.rating.count} ta baho
          </p>
        ) : null}
      </header>

      <div className="mb-10 flex flex-wrap items-end gap-6">
        <PriceBoard
          minor={product.price.amount}
          previousMinor={product.oldPrice?.amount ?? null}
          unit={unit}
          size="lg"
        />
        {dropped && product.discountPercent ? (
          <p className="font-body text-sm text-ink/70 dark:text-paper/70">
            Narx <span className="text-tile">{product.discountPercent}%</span> tushdi
          </p>
        ) : null}
      </div>

      {product.isPurchasable ? (
        <p className="mb-8 font-body text-sm text-ink/70 dark:text-paper/70">
          Hozir bor —{' '}
          <span className="text-ink dark:text-paper">
            {formatQuantity(product.availableQty.value, unit)}
          </span>
        </p>
      ) : (
        <div className="mb-8 rounded-stall border border-pomegranate/25 bg-pomegranate/5 px-4 py-3">
          <p className="font-body text-sm text-pomegranate">Bugun tugagan</p>
          <p className="mt-1 font-body text-xs text-ink/60 dark:text-paper/60">
            Sevimlilarga qo'shsangiz, qaytib kelganda xabar beramiz.
          </p>
        </div>
      )}

      <div className="mb-10">
        <AddToCart product={product} />
      </div>

      {/*
        Order rules, stated plainly rather than as a table of jargon. The tolerance is the one
        that surprises people: produce is weighed by hand, so what arrives is close to what was
        ordered and not exact, and saying so here prevents a dispute later.
      */}
      <section aria-labelledby="rules-heading" className="border-t border-ink/10 pt-8 dark:border-paper/10">
        <h2 id="rules-heading" className="mb-4 font-display text-base font-medium text-ink dark:text-paper">
          Qanday sotiladi
        </h2>
        <dl className="grid gap-4 font-body text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-ink/45 dark:text-paper/45">Eng kam buyurtma</dt>
            <dd className="mt-1 text-ink dark:text-paper">
              {formatQuantity(product.minOrderQty.value, product.minOrderQty.unit)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink/45 dark:text-paper/45">Qadam</dt>
            <dd className="mt-1 text-ink dark:text-paper">
              {formatQuantity(product.stepQty.value, product.stepQty.unit)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink/45 dark:text-paper/45">Tortishdagi farq</dt>
            <dd className="mt-1 text-ink dark:text-paper">±{product.tolerancePercent}%</dd>
          </div>
        </dl>
        <p className="mt-4 max-w-lg font-body text-xs leading-relaxed text-ink/55 dark:text-paper/55">
          Mahsulot qo'lda tortiladi, shuning uchun og'irlik buyurtmadagidan biroz farq qilishi
          mumkin. To'lov haqiqiy og'irlik bo'yicha hisoblanadi.
        </p>
      </section>
    </main>
  );
}
