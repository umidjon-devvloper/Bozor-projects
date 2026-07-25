'use client';

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatSom } from '@bozorlar/api-client';
import type { OrderResponse } from '@bozorlar/contracts';
import { useApi, useSession } from '@bozorlar/session';

/**
 * The buyer's orders.
 *
 * An order at a bazaar is a promise to walk somewhere, so the page is organised around what the
 * buyer has to do next rather than around order history. Anything still live comes first with
 * the stall address and the pickup window; anything finished collapses to a line.
 *
 * The status vocabulary is the server's, translated once here. There are twelve states and
 * inventing a friendlier subset would mean showing somebody a word the seller's screen does not
 * use — which is the sort of mismatch that produces a phone call.
 */

const STATUS_LABEL: Record<string, string> = {
  PENDING: 'Do\u2019kon javobini kutmoqda',
  ACCEPTED: 'Qabul qilindi',
  PREPARING: 'Tayyorlanmoqda',
  READY_FOR_PICKUP: 'Olib ketishga tayyor',
  PENDING_ADJUSTMENT: 'O\u2019zgarish tasdiqlanishi kerak',
  PICKED_UP: 'Olindi',
  COMPLETED: 'Yakunlandi',
  REJECTED: 'Do\u2019kon rad etdi',
  EXPIRED: 'Javob kelmadi',
  CANCELLED: 'Bekor qilindi',
  DISPUTED: 'Nizo ochilgan',
  REFUNDED: 'Pul qaytarildi',
};

const LIVE = new Set([
  'PENDING',
  'ACCEPTED',
  'PREPARING',
  'READY_FOR_PICKUP',
  'PENDING_ADJUSTMENT',
  'PICKED_UP',
]);

export default function OrdersPage() {
  const api = useApi();
  const { status } = useSession();
  const queryClient = useQueryClient();

  const orders = useQuery({
    queryKey: ['orders'],
    queryFn: () => api.orders.list({ limit: 50 }).then((response) => response.data),
    enabled: status === 'signed-in',
    // A live order changes because a seller acted, not because this tab did. Polling while the
    // page is open is the difference between learning the order is ready and not learning it.
    refetchInterval: 30_000,
  });

  const confirm = useMutation({
    mutationFn: (id: string) => api.orders.confirm(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['orders'] }),
  });

  if (status === 'signed-out') {
    return (
      <Shell>
        <p className="font-body text-sm text-ink/70 dark:text-paper/70">
          Buyurtmalaringizni ko'rish uchun kiring.
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

  if (orders.isPending || status === 'loading') {
    return <Shell><p className="font-body text-sm text-ink/50 dark:text-paper/50">Yuklanmoqda…</p></Shell>;
  }

  if (orders.isError) {
    return (
      <Shell>
        <p role="alert" className="font-body text-sm text-pomegranate">
          Buyurtmalarni ochib bo'lmadi.
        </p>
      </Shell>
    );
  }

  const live = orders.data.filter((order) => LIVE.has(order.status));
  const past = orders.data.filter((order) => !LIVE.has(order.status));

  if (orders.data.length === 0) {
    return (
      <Shell>
        <p className="font-body text-sm text-ink/70 dark:text-paper/70">Hali buyurtma yo'q.</p>
        <Link href="/" className="mt-4 inline-block font-body text-sm text-tile hover:underline">
          Bozorlarni ko'rish
        </Link>
      </Shell>
    );
  }

  return (
    <Shell>
      {live.length > 0 ? (
        <ul className="space-y-4">
          {live.map((order) => (
            <li key={order.id}>
              <LiveOrder
                order={order}
                onConfirm={() => confirm.mutate(order.id)}
                confirming={confirm.isPending && confirm.variables === order.id}
              />
            </li>
          ))}
        </ul>
      ) : null}

      {past.length > 0 ? (
        <section className="mt-12">
          <h2 className="mb-4 font-display text-base font-medium text-ink/70 dark:text-paper/70">
            Oldingi buyurtmalar
          </h2>
          <ul className="divide-y divide-ink/10 dark:divide-paper/10">
            {past.map((order) => (
              <li key={order.id} className="flex items-baseline justify-between gap-4 py-3">
                <Link
                  href={`/buyurtmalarim/${order.id}`}
                  className="min-w-0 font-body text-sm text-ink/70 hover:text-tile dark:text-paper/70"
                >
                  <span className="tabular-nums">{order.orderNo}</span>
                  <span className="px-1.5 text-saffron">·</span>
                  {order.shop.name}
                </Link>
                <span className="shrink-0 font-body text-xs text-ink/50 dark:text-paper/50">
                  {STATUS_LABEL[order.status] ?? order.status}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </Shell>
  );
}

function LiveOrder({
  order,
  onConfirm,
  confirming,
}: {
  order: OrderResponse;
  onConfirm: () => void;
  confirming: boolean;
}) {
  const address = [order.shop.marketName, order.shop.sectionCode, order.shop.stallNo ? `${order.shop.stallNo}-do'kon` : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <article className="rounded-stall border border-ink/10 bg-white/60 p-4 dark:border-paper/10 dark:bg-paper/5">
      <div className="flex items-baseline justify-between gap-4">
        <Link
          href={`/buyurtmalarim/${order.id}`}
          className="font-body text-xs tabular-nums text-ink/50 hover:text-tile dark:text-paper/50"
        >
          {order.orderNo}
        </Link>
        <span className="rounded-full bg-tile/10 px-2.5 py-1 font-body text-xs text-tile dark:text-tile-light">
          {STATUS_LABEL[order.status] ?? order.status}
        </span>
      </div>

      <h3 className="mt-2 font-display text-base font-medium text-ink dark:text-paper">
        {order.shop.name}
      </h3>
      <p className="mt-0.5 font-body text-xs text-ink/55 dark:text-paper/55">{address}</p>

      <ul className="mt-3 space-y-1">
        {order.lines.map((line) => (
          <li key={line.lineId} className="font-body text-sm text-ink/80 dark:text-paper/80">
            {line.name}
            <span className="ml-2 text-ink/50 dark:text-paper/50">
              {(line.confirmedQty ?? line.orderedQty).value} {line.unit}
            </span>
          </li>
        ))}
      </ul>

      {order.pickupWindow ? (
        <p className="mt-3 font-body text-xs text-ink/60 dark:text-paper/60">
          Olib ketish:{' '}
          {new Date(order.pickupWindow.from).toLocaleTimeString('uz', { hour: '2-digit', minute: '2-digit' })}
          {' – '}
          {new Date(order.pickupWindow.to).toLocaleTimeString('uz', { hour: '2-digit', minute: '2-digit' })}
        </p>
      ) : null}

      {/* The stall's number appears only once the order is live — it is null before that. */}
      {order.shop.phone ? (
        <a
          href={`tel:${order.shop.phone}`}
          className="mt-1 inline-block font-body text-xs text-tile hover:underline dark:text-tile-light"
        >
          {order.shop.phone}
        </a>
      ) : null}

      <div className="mt-4 flex items-center justify-between gap-4 border-t border-ink/10 pt-3 dark:border-paper/10">
        <span className="font-display text-lg tabular-nums text-ink dark:text-paper">
          {formatSom(order.totals.grand.amount)} so'm
        </span>

        {/* Server-computed: the button exists only when the action would be accepted. */}
        {order.canConfirm ? (
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirming}
            className="rounded-stall bg-tile px-3.5 py-2 font-display text-sm text-paper hover:bg-tile-deep disabled:opacity-60"
          >
            {confirming ? 'Yuborilmoqda…' : 'Oldim, tasdiqlayman'}
          </button>
        ) : null}
      </div>
    </article>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-2xl px-5 pb-24 pt-10 sm:px-8">
      <h1 className="mb-8 font-display text-3xl font-bold text-ink dark:text-paper">
        Buyurtmalarim
      </h1>
      {children}
    </main>
  );
}
