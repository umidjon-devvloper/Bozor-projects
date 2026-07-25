'use client';

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatSom } from '@bozorlar/api-client';
import type { CartLineResponse } from '@bozorlar/contracts';
import { useApi, useSession } from '@bozorlar/session';

/**
 * The basket.
 *
 * A bazaar basket is not a supermarket one: the goods come from several stalls, each stall is
 * collected separately, and a price can move between adding something and paying for it. All
 * three show up here rather than being smoothed over — grouped by stall, with a per-line note
 * when something changed, because the buyer is the one who has to walk to each stall.
 */
export default function CartPage() {
  const api = useApi();
  const { status } = useSession();
  const queryClient = useQueryClient();

  const cart = useQuery({
    queryKey: ['cart'],
    queryFn: () => api.cart.get().then((response) => response.data),
    enabled: status === 'signed-in',
  });

  const remove = useMutation({
    mutationFn: (lineId: string) => api.cart.removeItem(lineId),
    onSuccess: (response) => queryClient.setQueryData(['cart'], response.data),
  });

  if (status === 'loading') {
    return <Shell><p className="font-body text-sm text-ink/50 dark:text-paper/50">Yuklanmoqda…</p></Shell>;
  }

  if (status === 'signed-out') {
    return (
      <Shell>
        <p className="font-body text-sm text-ink/70 dark:text-paper/70">
          Savatni ko'rish uchun kiring.
        </p>
        <Link
          href="/kirish"
          className="mt-4 inline-block rounded-stall bg-tile px-4 py-2.5 font-display text-sm text-paper hover:bg-tile-deep"
        >
          Kirish
        </Link>
      </Shell>
    );
  }

  if (cart.isPending) {
    return <Shell><p className="font-body text-sm text-ink/50 dark:text-paper/50">Savat yuklanmoqda…</p></Shell>;
  }

  if (cart.isError || !cart.data) {
    return (
      <Shell>
        <p role="alert" className="font-body text-sm text-pomegranate">
          Savatni ochib bo'lmadi.
        </p>
        <button
          type="button"
          onClick={() => void cart.refetch()}
          className="mt-4 rounded-stall border border-ink/15 px-4 py-2 font-body text-sm text-ink dark:border-paper/15 dark:text-paper"
        >
          Qayta urinish
        </button>
      </Shell>
    );
  }

  if (cart.data.items.length === 0) {
    return (
      <Shell>
        <p className="font-body text-sm text-ink/70 dark:text-paper/70">Savat bo'sh.</p>
        <Link href="/" className="mt-4 inline-block font-body text-sm text-tile hover:underline">
          Bozorlarni ko'rish
        </Link>
      </Shell>
    );
  }

  return (
    <Shell>
      <ul className="space-y-3">
        {cart.data.items.map((line) => (
          <li key={line.lineId}>
            <CartLine
              line={line}
              onRemove={() => remove.mutate(line.lineId)}
              removing={remove.isPending && remove.variables === line.lineId}
            />
          </li>
        ))}
      </ul>

      <div className="mt-8 border-t border-ink/10 pt-6 dark:border-paper/10">
        <div className="flex items-baseline justify-between">
          <span className="font-body text-sm text-ink/60 dark:text-paper/60">
            {cart.data.itemCount} ta mahsulot
          </span>
          <span className="font-display text-2xl font-bold tabular-nums text-ink dark:text-paper">
            {formatSom(cart.data.subtotal.amount)} so'm
          </span>
        </div>

        {cart.data.hasIssues ? (
          <p role="alert" className="mt-4 rounded-stall bg-pomegranate/10 px-3 py-2 font-body text-sm text-pomegranate">
            Ba'zi mahsulotlarda muammo bor. Buyurtmani rasmiylashtirishdan oldin ularni
            tuzating.
          </p>
        ) : (
          <Link
            href="/checkout"
            className="mt-5 block w-full rounded-stall bg-tile px-4 py-3 text-center font-display text-sm font-medium text-paper hover:bg-tile-deep"
          >
            Buyurtmani rasmiylashtirish
          </Link>
        )}
      </div>
    </Shell>
  );
}

function CartLine({
  line,
  onRemove,
  removing,
}: {
  line: CartLineResponse;
  onRemove: () => void;
  removing: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-stall border border-ink/10 bg-white/60 p-4 dark:border-paper/10 dark:bg-paper/5">
      <div className="min-w-0">
        <Link
          href={`/products/${line.slug}`}
          className="font-display text-base font-medium text-ink hover:text-tile dark:text-paper"
        >
          {line.name}
        </Link>
        <p className="mt-1 font-body text-xs text-ink/55 dark:text-paper/55">
          {line.qty.value} {line.qty.unit}
          {line.unitPrice ? ` · ${formatSom(line.unitPrice.amount)} so'm/${line.qty.unit}` : ''}
        </p>

        {/*
          A changed price is stated, not silently applied. Somebody who put tomatoes in an hour
          ago at one price and is charged another has been misled, even if the new price is on
          the product page.
        */}
        {line.priceChanged ? (
          <p className="mt-1.5 font-body text-xs text-saffron-deep">Narx o'zgargan</p>
        ) : null}
        {!line.purchasable ? (
          <p className="mt-1.5 font-body text-xs text-pomegranate">Hozir mavjud emas</p>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-col items-end gap-2">
        {line.lineTotal ? (
          <span className="font-display text-base tabular-nums text-ink dark:text-paper">
            {formatSom(line.lineTotal.amount)}
          </span>
        ) : null}
        <button
          type="button"
          onClick={onRemove}
          disabled={removing}
          className="font-body text-xs text-ink/50 underline-offset-4 hover:text-pomegranate hover:underline disabled:opacity-50 dark:text-paper/50"
        >
          {removing ? 'O\u2019chirilmoqda…' : "O\u2019chirish"}
        </button>
      </div>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-2xl px-5 pb-24 pt-10 sm:px-8">
      <h1 className="mb-8 font-display text-3xl font-bold text-ink dark:text-paper">Savat</h1>
      {children}
    </main>
  );
}
