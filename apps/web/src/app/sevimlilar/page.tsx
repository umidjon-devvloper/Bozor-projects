'use client';

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatSom } from '@bozorlar/api-client';
import { useApi, useSession } from '@/lib/session';

/**
 * The products somebody is waiting on.
 *
 * This is the list the restock and price-drop alerts are sent from, so it shows the same two
 * facts the alert would: what it costs now, and whether it can be bought. A followed product
 * that has gone unavailable stays listed with the reason — that is the whole point of following
 * it, and removing it would silently end the alert the person is waiting for.
 */
export default function FavouritesPage() {
  const api = useApi();
  const { status } = useSession();
  const queryClient = useQueryClient();

  const favourites = useQuery({
    queryKey: ['favourites'],
    queryFn: () => api.favourites.products({ limit: 50 }).then((response) => response.data),
    enabled: status === 'signed-in',
  });

  const unfollow = useMutation({
    mutationFn: (productId: string) => api.favourites.remove('PRODUCT', productId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['favourites'] }),
  });

  if (status === 'signed-out') {
    return (
      <Shell>
        <p className="font-body text-sm text-ink/70 dark:text-paper/70">
          Kuzatayotgan mahsulotlaringizni ko'rish uchun kiring.
        </p>
        <Link href="/kirish" className="mt-4 inline-block rounded-stall bg-tile px-4 py-2.5 font-display text-sm text-paper hover:bg-tile-deep">
          Kirish
        </Link>
      </Shell>
    );
  }

  if (favourites.isPending || status === 'loading') {
    return <Shell><p className="font-body text-sm text-ink/50 dark:text-paper/50">Yuklanmoqda…</p></Shell>;
  }

  if (favourites.isError) {
    return <Shell><p role="alert" className="font-body text-sm text-pomegranate">Ro'yxatni ochib bo'lmadi.</p></Shell>;
  }

  if (favourites.data.length === 0) {
    return (
      <Shell>
        <p className="font-body text-sm text-ink/70 dark:text-paper/70">
          Hali hech narsa kuzatilmayapti.
        </p>
        <p className="mt-2 max-w-md font-body text-sm text-ink/55 dark:text-paper/55">
          Mahsulot sahifasida &laquo;Kuzatish&raquo; tugmasini bossangiz, narx tushganda yoki
          tugagan mahsulot qaytganda xabar beramiz.
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <ul className="grid gap-3">
        {favourites.data.map((item) => (
          <li
            key={item.id}
            className="flex items-start justify-between gap-4 rounded-stall border border-ink/10 bg-white/60 p-4 dark:border-paper/10 dark:bg-paper/5"
          >
            <div className="min-w-0">
              <Link
                href={`/products/${item.slug}`}
                className="font-display text-base font-medium text-ink hover:text-tile dark:text-paper"
              >
                {item.name}
              </Link>
              <p className="mt-1.5 font-body text-xs">
                {item.isPurchasable ? (
                  <span className="text-tile dark:text-tile-light">Hozir bor</span>
                ) : (
                  <span className="text-pomegranate">
                    {item.unavailableReason === 'OUT_OF_STOCK' ? 'Bugun tugagan' : 'Sotuvda emas'}
                  </span>
                )}
              </p>
              {!item.alertsEnabled ? (
                <p className="mt-1 font-body text-xs text-ink/45 dark:text-paper/45">
                  Xabarlar o'chirilgan
                </p>
              ) : null}
            </div>

            <div className="flex shrink-0 flex-col items-end gap-2">
              <span className="font-display text-base tabular-nums text-ink dark:text-paper">
                {formatSom(item.price)}
                <span className="ml-1 font-body text-xs text-ink/50 dark:text-paper/50">
                  /{item.unit}
                </span>
              </span>
              <button
                type="button"
                onClick={() => unfollow.mutate(item.productId)}
                disabled={unfollow.isPending && unfollow.variables === item.productId}
                className="font-body text-xs text-ink/50 underline-offset-4 hover:text-pomegranate hover:underline disabled:opacity-50 dark:text-paper/50"
              >
                Kuzatishni to'xtatish
              </button>
            </div>
          </li>
        ))}
      </ul>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-2xl px-5 pb-24 pt-10 sm:px-8">
      <h1 className="mb-8 font-display text-3xl font-bold text-ink dark:text-paper">Kuzatilayotganlar</h1>
      {children}
    </main>
  );
}
