'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatSom } from '@bozorlar/api-client';
import type { SearchHit } from '@bozorlar/api-client';
import { useApi } from '@/lib/session';

/**
 * Search across every stall in the republic.
 *
 * The query lives in the URL, not in component state, so a result page can be sent to somebody
 * or reopened from history — which at a bazaar is the normal way one person tells another where
 * to find something cheap.
 *
 * Results are index documents, not catalogue products: fewer fields, no stock quantity, a
 * truncated name. The card is built to that rather than pretending otherwise, and everything it
 * cannot answer is one tap away on the product page.
 */
export default function SearchPage() {
  return (
    <Suspense fallback={null}>
      <SearchView />
    </Suspense>
  );
}

function SearchView() {
  const api = useApi();
  const router = useRouter();
  const params = useSearchParams();
  const q = params.get('q') ?? '';
  const [draft, setDraft] = useState(q);

  const results = useQuery({
    queryKey: ['search', q],
    queryFn: () => api.search.products({ q, perPage: 30 }).then((response) => response.data),
    // No query, no request: an empty search would ask the index for everything.
    enabled: q.trim().length > 0,
  });

  return (
    <main className="mx-auto w-full max-w-3xl px-5 pb-24 pt-10 sm:px-8">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          router.push(`/qidiruv?q=${encodeURIComponent(draft.trim())}`);
        }}
        className="mb-8 flex gap-2"
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Pomidor, non, asal…"
          aria-label="Mahsulot qidirish"
          className="w-full rounded-stall border border-ink/15 bg-white px-4 py-3 font-body text-base text-ink placeholder:text-ink/30 dark:border-paper/15 dark:bg-paper/5 dark:text-paper"
        />
        <button
          type="submit"
          className="shrink-0 rounded-stall bg-tile px-5 font-display text-sm font-medium text-paper hover:bg-tile-deep"
        >
          Qidirish
        </button>
      </form>

      {q.trim().length === 0 ? (
        <p className="font-body text-sm text-ink/55 dark:text-paper/55">
          Mahsulot nomini yozing — respublika bo'ylab barcha do'konlardan qidiramiz.
        </p>
      ) : results.isPending ? (
        <p className="font-body text-sm text-ink/50 dark:text-paper/50">Qidirilmoqda…</p>
      ) : results.isError ? (
        <p role="alert" className="font-body text-sm text-pomegranate">
          Qidiruv ishlamadi. Birozdan so'ng qayta urinib ko'ring.
        </p>
      ) : results.data.items.length === 0 ? (
        <div>
          <p className="font-body text-sm text-ink/70 dark:text-paper/70">
            &laquo;{q}&raquo; bo'yicha hech narsa topilmadi.
          </p>
          <p className="mt-2 font-body text-sm text-ink/55 dark:text-paper/55">
            Boshqacha yozib ko'ring yoki bozorni tanlab, do'konlarni ko'zdan kechiring.
          </p>
        </div>
      ) : (
        <>
          <p className="mb-4 font-body text-xs text-ink/50 dark:text-paper/50">
            {results.data.found} ta natija
          </p>
          <ul className="grid gap-3">
            {results.data.items.map((hit) => (
              <li key={hit.id}>
                <HitCard hit={hit} />
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}

function HitCard({ hit }: { hit: SearchHit }) {
  return (
    <Link
      href={`/products/${hit.id}`}
      className="group flex items-start justify-between gap-4 rounded-stall border border-ink/10 bg-white/60 p-4 transition-shadow hover:shadow-lift dark:border-paper/10 dark:bg-paper/5"
    >
      <div className="min-w-0">
        <h2 className="truncate font-display text-base font-medium text-ink group-hover:text-tile dark:text-paper">
          {hit.name}
        </h2>
        <p className="mt-1 font-body text-xs text-ink/55 dark:text-paper/55">{hit.shop.name}</p>
        {!hit.inStock ? (
          <p className="mt-1 font-body text-xs text-pomegranate">Bugun tugagan</p>
        ) : null}
      </div>
      <span className="shrink-0 font-display text-base tabular-nums text-ink dark:text-paper">
        {formatSom(hit.price.amount)}
        <span className="ml-1 font-body text-xs text-ink/50 dark:text-paper/50">/{hit.unit}</span>
      </span>
    </Link>
  );
}
