'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, formatSom } from '@bozorlar/api-client';
import { useApi, useSession } from '@/lib/session';

/**
 * One order, in full — and the place a dispute is raised.
 *
 * The line table shows ordered against confirmed weight side by side, because that difference
 * is what a disagreement is actually about. Produce is weighed by hand within a stated
 * tolerance; showing only the final figure would leave the buyer to remember what they asked
 * for, and remembering wrongly is how a fair handover becomes an argument.
 */

const REASONS: { value: string; label: string }[] = [
  { value: 'SHORT_WEIGHT', label: "Og'irlik kam chiqdi" },
  { value: 'WRONG_ITEM', label: "Boshqa mahsulot berildi" },
  { value: 'POOR_QUALITY', label: 'Sifati yomon' },
  { value: 'SPOILED', label: 'Buzilgan' },
  { value: 'NOT_RECEIVED', label: 'Olmadim' },
  { value: 'OVERCHARGED', label: "Ortiqcha hisoblandi" },
  { value: 'OTHER', label: 'Boshqa sabab' },
];

export default function OrderPage() {
  const api = useApi();
  const { status } = useSession();
  const params = useParams<{ id: string }>();
  const queryClient = useQueryClient();

  const order = useQuery({
    queryKey: ['order', params.id],
    queryFn: () => api.orders.get(params.id).then((response) => response.data),
    enabled: status === 'signed-in',
  });

  const [raising, setRaising] = useState(false);
  const [reason, setReason] = useState(REASONS[0]?.value ?? 'OTHER');
  const [claim, setClaim] = useState('');
  const [error, setError] = useState<string | null>(null);

  const dispute = useMutation({
    mutationFn: () => api.disputes.raise({ orderId: params.id, reason, claim }),
    onSuccess: () => {
      setRaising(false);
      setClaim('');
      void queryClient.invalidateQueries({ queryKey: ['order', params.id] });
    },
    onError: (caught) =>
      setError(caught instanceof ApiError ? (caught.detail ?? caught.message) : 'Yuborilmadi.'),
  });

  if (status === 'signed-out') {
    return <Shell><Link href="/kirish" className="font-body text-sm text-tile hover:underline">Kirish</Link></Shell>;
  }
  if (order.isPending) return <Shell><p className="font-body text-sm text-ink/50 dark:text-paper/50">Yuklanmoqda…</p></Shell>;
  if (order.isError || !order.data) {
    return <Shell><p role="alert" className="font-body text-sm text-pomegranate">Buyurtma topilmadi.</p></Shell>;
  }

  const data = order.data;

  return (
    <Shell>
      <p className="font-body text-xs tabular-nums text-ink/50 dark:text-paper/50">{data.orderNo}</p>
      <h1 className="mt-1 font-display text-2xl font-bold text-ink dark:text-paper">
        {data.shop.name}
      </h1>
      <p className="mt-1 font-body text-xs text-ink/55 dark:text-paper/55">
        {[data.shop.marketName, data.shop.sectionCode, data.shop.stallNo ? `${data.shop.stallNo}-do'kon` : null]
          .filter(Boolean)
          .join(' · ')}
      </p>

      <table className="mt-8 w-full text-left font-body text-sm">
        <thead>
          <tr className="border-b border-ink/10 text-xs text-ink/45 dark:border-paper/10 dark:text-paper/45">
            <th scope="col" className="pb-2 font-normal">Mahsulot</th>
            <th scope="col" className="pb-2 text-right font-normal">Buyurtma</th>
            <th scope="col" className="pb-2 text-right font-normal">Tortilgan</th>
            <th scope="col" className="pb-2 text-right font-normal">Summa</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink/5 dark:divide-paper/5">
          {data.lines.map((line) => (
            <tr key={line.lineId}>
              <td className="py-2.5 text-ink dark:text-paper">{line.name}</td>
              <td className="py-2.5 text-right tabular-nums text-ink/60 dark:text-paper/60">
                {line.orderedQty.value} {line.unit}
              </td>
              <td className="py-2.5 text-right tabular-nums text-ink dark:text-paper">
                {line.confirmedQty ? `${line.confirmedQty.value} ${line.unit}` : '—'}
              </td>
              <td className="py-2.5 text-right tabular-nums text-ink dark:text-paper">
                {formatSom(line.lineTotal.amount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-6 flex items-baseline justify-between border-t border-ink/10 pt-4 dark:border-paper/10">
        <span className="font-body text-sm text-ink/60 dark:text-paper/60">Jami</span>
        <span className="font-display text-xl tabular-nums text-ink dark:text-paper">
          {formatSom(data.totals.grand.amount)} so'm
        </span>
      </div>

      {/* Server-computed: the window for raising a dispute is a rule, not a guess. */}
      {data.canDispute ? (
        <section className="mt-10 border-t border-ink/10 pt-8 dark:border-paper/10">
          {!raising ? (
            <button
              type="button"
              onClick={() => setRaising(true)}
              className="rounded-stall border border-pomegranate/30 px-4 py-2.5 font-body text-sm text-pomegranate hover:bg-pomegranate/5"
            >
              Buyurtma bo'yicha shikoyat qilish
            </button>
          ) : (
            <div className="space-y-4">
              <h2 className="font-display text-base font-medium text-ink dark:text-paper">
                Nima bo'ldi?
              </h2>

              <select
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                aria-label="Shikoyat sababi"
                className="w-full rounded-stall border border-ink/15 bg-white px-3 py-2.5 font-body text-sm text-ink dark:border-paper/15 dark:bg-paper/5 dark:text-paper"
              >
                {REASONS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>

              <textarea
                value={claim}
                onChange={(event) => setClaim(event.target.value)}
                rows={4}
                minLength={10}
                placeholder="Qisqacha yozing — moderator shu matnni o'qiydi."
                className="w-full rounded-stall border border-ink/15 bg-white px-3 py-2.5 font-body text-sm text-ink placeholder:text-ink/30 dark:border-paper/15 dark:bg-paper/5 dark:text-paper"
              />

              {error ? (
                <p role="alert" className="font-body text-sm text-pomegranate">{error}</p>
              ) : null}

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => dispute.mutate()}
                  disabled={claim.trim().length < 10 || dispute.isPending}
                  className="rounded-stall bg-pomegranate px-4 py-2.5 font-display text-sm text-paper hover:opacity-90 disabled:opacity-50"
                >
                  {dispute.isPending ? 'Yuborilmoqda…' : 'Yuborish'}
                </button>
                <button
                  type="button"
                  onClick={() => setRaising(false)}
                  className="rounded-stall px-4 py-2.5 font-body text-sm text-ink/60 dark:text-paper/60"
                >
                  Bekor qilish
                </button>
              </div>

              <p className="font-body text-xs text-ink/50 dark:text-paper/50">
                Kuniga eng ko'pi 5 ta shikoyat yuborish mumkin — har biri moderator vaqtini
                oladi.
              </p>
            </div>
          )}
        </section>
      ) : null}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-2xl px-5 pb-24 pt-10 sm:px-8">
      <Link href="/buyurtmalarim" className="font-body text-xs text-ink/50 hover:text-tile dark:text-paper/50">
        ← Buyurtmalarim
      </Link>
      <div className="mt-6">{children}</div>
    </main>
  );
}
