'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ApiError } from '@bozorlar/api-client';
import { useApi, useSession } from '@/lib/session';

/**
 * Following a product.
 *
 * The state is optimistic and reverts on failure, because the whole interaction is one tap and
 * a spinner on a heart is more disruptive than the rare correction. What it must not do is
 * appear to have worked when it did not: a shopper who thinks they are following a product will
 * wait for a restock alert that never comes.
 *
 * For a signed-out visitor the tap goes to sign-in rather than being hidden. Wanting to be told
 * when the tomatoes come back is exactly the reason to make an account, and a control that is
 * simply absent teaches nobody that.
 */
export function FavouriteButton({ productId }: { productId: string }) {
  const api = useApi();
  const { status } = useSession();
  const router = useRouter();
  const [following, setFollowing] = useState<boolean | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (status !== 'signed-in') {
      setFollowing(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await api.favourites.status([productId]);
        if (!cancelled) setFollowing(data.followed.includes(productId));
      } catch {
        if (!cancelled) setFollowing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, productId, status]);

  async function toggle(): Promise<void> {
    if (status !== 'signed-in') {
      router.push('/kirish');
      return;
    }
    const next = !following;
    setFollowing(next);
    setError(false);
    try {
      if (next) await api.favourites.add('PRODUCT', productId);
      else await api.favourites.remove('PRODUCT', productId);
    } catch (caught) {
      setFollowing(!next);
      setError(caught instanceof ApiError);
    }
  }

  const active = following === true;

  return (
    <div>
      <button
        type="button"
        onClick={() => void toggle()}
        aria-pressed={active}
        className={
          active
            ? 'flex items-center gap-2 rounded-stall border border-saffron/40 bg-saffron/10 px-3.5 py-2.5 font-body text-sm text-saffron-deep'
            : 'flex items-center gap-2 rounded-stall border border-ink/15 px-3.5 py-2.5 font-body text-sm text-ink/70 hover:border-saffron/40 hover:text-saffron-deep dark:border-paper/15 dark:text-paper/70'
        }
      >
        <span aria-hidden>{active ? '★' : '☆'}</span>
        {active ? 'Kuzatilmoqda' : 'Kuzatish'}
      </button>

      {active ? (
        <p className="mt-2 font-body text-xs text-ink/55 dark:text-paper/55">
          Narx tushsa yoki qaytib kelsa xabar beramiz.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="mt-2 font-body text-xs text-pomegranate">
          Saqlanmadi. Qayta urinib ko'ring.
        </p>
      ) : null}
    </div>
  );
}
