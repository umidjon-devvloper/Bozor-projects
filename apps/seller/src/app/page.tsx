'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, formatSom } from '@bozorlar/api-client';
import type { OrderResponse } from '@bozorlar/contracts';
import { useApi, useSession } from '@bozorlar/session';

/**
 * The morning queue.
 *
 * This is the screen a seller keeps open on a tablet propped against the scales, glanced at
 * between customers. Everything about it follows from that: one action per order, the action
 * the order is actually waiting for, and a countdown on anything with a deadline.
 *
 * Orders are grouped by what the seller must do rather than by status name. A stall working
 * through a morning does not think "which of these are ACCEPTED" — it thinks "what do I answer,
 * what do I weigh out, who is coming to collect".
 */

const NEEDS_ANSWER = new Set(['PENDING']);
const IN_HAND = new Set(['ACCEPTED', 'PREPARING']);
const WAITING_COLLECTION = new Set(['READY_FOR_PICKUP']);

export default function QueuePage() {
  const api = useApi();
  const { status } = useSession();
  const queryClient = useQueryClient();

  const orders = useQuery({
    queryKey: ['seller-orders'],
    queryFn: () => api.seller.orders.list({ limit: 100 }).then((response) => response.data),
    enabled: status === 'signed-in',
    // A new order arrives because a shopper acted. Ten seconds is the difference between
    // answering inside the accept window and letting it expire.
    refetchInterval: 10_000,
  });

  const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey: ['seller-orders'] });

  const accept = useMutation({ mutationFn: (id: string) => api.seller.orders.accept(id), onSuccess: invalidate });
  const preparing = useMutation({ mutationFn: (id: string) => api.seller.orders.preparing(id), onSuccess: invalidate });
  const ready = useMutation({ mutationFn: (id: string) => api.seller.orders.ready(id), onSuccess: invalidate });

  if (status === 'loading') return <Shell><Muted>Yuklanmoqda…</Muted></Shell>;
  if (status === 'signed-out') return <Shell><SignIn /></Shell>;
  if (orders.isPending) return <Shell><Muted>Buyurtmalar yuklanmoqda…</Muted></Shell>;
  if (orders.isError) {
    return <Shell><p role="alert" className="font-body text-sm text-pomegranate">Buyurtmalarni ochib bo'lmadi.</p></Shell>;
  }

  const answer = orders.data.filter((order) => NEEDS_ANSWER.has(order.status));
  const prepare = orders.data.filter((order) => IN_HAND.has(order.status));
  const collect = orders.data.filter((order) => WAITING_COLLECTION.has(order.status));

  const empty = answer.length + prepare.length + collect.length === 0;

  return (
    <Shell>
      {empty ? (
        <div className="rounded-stall border border-dashed border-ink/20 px-6 py-16 text-center dark:border-paper/20">
          <p className="font-display text-base text-ink dark:text-paper">Hozircha yangi buyurtma yo'q</p>
          <p className="mx-auto mt-2 max-w-sm font-body text-sm text-ink/60 dark:text-paper/60">
            Bu sahifa o'zi yangilanadi — buyurtma kelsa shu yerda chiqadi.
          </p>
        </div>
      ) : null}

      <Group title="Javob kutmoqda" tone="urgent" orders={answer}>
        {(order) => (
          <Action
            label="Qabul qilish"
            busy={accept.isPending && accept.variables === order.id}
            onClick={() => accept.mutate(order.id)}
          />
        )}
      </Group>

      <Group title="Tayyorlash" orders={prepare}>
        {(order) =>
          order.status === 'ACCEPTED' ? (
            <Action
              label="Tayyorlashni boshladim"
              busy={preparing.isPending && preparing.variables === order.id}
              onClick={() => preparing.mutate(order.id)}
            />
          ) : (
            <Action
              label="Tayyor"
              busy={ready.isPending && ready.variables === order.id}
              onClick={() => ready.mutate(order.id)}
            />
          )
        }
      </Group>

      <Group title="Olib ketishni kutmoqda" orders={collect}>
        {(order) => <PickupCode order={order} onDone={() => void invalidate()} />}
      </Group>
    </Shell>
  );
}

/**
 * The handover.
 *
 * The buyer reads six digits off their phone and the seller types them in. Attempts are capped
 * on the server, so a wrong code is stated plainly rather than being retried silently — a
 * seller who does not know the code was refused will hand the goods over anyway.
 */
function PickupCode({ order, onDone }: { order: OrderResponse; onDone: () => void }) {
  const api = useApi();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const verify = useMutation({
    mutationFn: () => api.seller.orders.verifyPickup(order.id, code),
    onSuccess: () => {
      setCode('');
      setError(null);
      onDone();
    },
    onError: (caught) =>
      setError(caught instanceof ApiError ? (caught.detail ?? caught.message) : 'Tekshirib bo\u2019lmadi.'),
  });

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex gap-2">
        <input
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
          inputMode="numeric"
          placeholder="000000"
          aria-label="Olib ketish kodi"
          className="w-28 rounded-stall border border-ink/15 bg-white px-3 py-2 text-center font-display text-lg tabular-nums tracking-widest text-ink dark:border-paper/15 dark:bg-paper/5 dark:text-paper"
        />
        <button
          type="button"
          onClick={() => verify.mutate()}
          disabled={code.length !== 6 || verify.isPending}
          className="rounded-stall bg-saffron px-4 py-2 font-display text-sm text-ink hover:bg-saffron-deep disabled:opacity-50"
        >
          {verify.isPending ? '…' : 'Berdim'}
        </button>
      </div>
      {error ? (
        <p role="alert" className="font-body text-xs text-pomegranate">{error}</p>
      ) : null}
    </div>
  );
}

function Group({
  title,
  tone,
  orders,
  children,
}: {
  title: string;
  tone?: 'urgent';
  orders: OrderResponse[];
  children: (order: OrderResponse) => React.ReactNode;
}) {
  if (orders.length === 0) return null;
  return (
    <section className="mb-10">
      <h2
        className={
          tone === 'urgent'
            ? 'mb-4 font-display text-base font-medium text-pomegranate'
            : 'mb-4 font-display text-base font-medium text-ink/70 dark:text-paper/70'
        }
      >
        {title}
        <span className="ml-2 font-body text-sm text-ink/45 dark:text-paper/45">{orders.length}</span>
      </h2>
      <ul className="space-y-3">
        {orders.map((order) => (
          <li
            key={order.id}
            className="flex flex-wrap items-start justify-between gap-4 rounded-stall border border-ink/10 bg-white/60 p-4 dark:border-paper/10 dark:bg-paper/5"
          >
            <div className="min-w-0">
              <p className="font-body text-xs tabular-nums text-ink/50 dark:text-paper/50">
                {order.orderNo}
              </p>
              <ul className="mt-1.5 space-y-0.5">
                {order.lines.map((line) => (
                  <li key={line.lineId} className="font-body text-sm text-ink dark:text-paper">
                    {line.name}
                    <span className="ml-2 tabular-nums text-ink/55 dark:text-paper/55">
                      {(line.confirmedQty ?? line.orderedQty).value} {line.unit}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 font-display text-base tabular-nums text-ink dark:text-paper">
                {formatSom(order.totals.grand.amount)} so'm
              </p>
              <Deadline order={order} />
            </div>
            {children(order)}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The only clock that matters: an unanswered order expires and the stall loses the sale. */
function Deadline({ order }: { order: OrderResponse }) {
  if (!order.acceptDeadline || order.status !== 'PENDING') return null;
  const minutes = Math.max(
    0,
    Math.round((new Date(order.acceptDeadline).getTime() - Date.now()) / 60_000),
  );
  return (
    <p className="mt-1 font-body text-xs text-pomegranate">
      Javob berishga {minutes} daqiqa qoldi
    </p>
  );
}

function Action({ label, busy, onClick }: { label: string; busy: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="shrink-0 rounded-stall bg-saffron px-4 py-2.5 font-display text-sm font-medium text-ink hover:bg-saffron-deep disabled:opacity-50"
    >
      {busy ? '…' : label}
    </button>
  );
}

function SignIn() {
  return (
    <div>
      <p className="font-body text-sm text-ink/70 dark:text-paper/70">
        Kabinetga kirish uchun do'kon egasi hisobi kerak.
      </p>
      <a
        href="/kirish"
        className="mt-4 inline-block rounded-stall bg-saffron px-4 py-2.5 font-display text-sm text-ink hover:bg-saffron-deep"
      >
        Kirish
      </a>
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p className="font-body text-sm text-ink/50 dark:text-paper/50">{children}</p>;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-4xl px-5 pb-24 pt-8 sm:px-8">
      <h1 className="mb-8 font-display text-2xl font-bold text-ink dark:text-paper">Buyurtmalar</h1>
      {children}
    </main>
  );
}
