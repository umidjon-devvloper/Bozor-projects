'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ApiError, formatSom } from '@bozorlar/api-client';
import type { QuoteResponse } from '@bozorlar/contracts';
import { useApi, useSession } from '@bozorlar/session';

/**
 * Checkout: confirm what each stall will hand over, then order.
 *
 * A quote is asked for exactly once, on arrival. It takes real stock out of circulation for
 * fifteen minutes, so re-requesting it on every render would lock a popular product out of the
 * market for everyone else — which is why the API rate-limits it and why the ref below guards
 * against React's development double-invoke.
 *
 * The page is grouped by stall because that is how the goods are collected: each group is a
 * separate walk, a separate pickup window, and after ordering, a separate order.
 */
export default function CheckoutPage() {
  const api = useApi();
  const { status } = useSession();
  const router = useRouter();

  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const requested = useRef(false);

  /**
   * One key per checkout attempt, held for as long as the page is open.
   *
   * This is what makes a retry safe. On a bazaar's mobile network a request can time out after
   * the server has already accepted it; tapping again with the same key returns the original
   * order instead of creating a second one.
   */
  const idempotencyKey = useRef<string>(
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `ck_${Date.now()}_${Math.random().toString(36).slice(2)}`,
  );

  useEffect(() => {
    if (status !== 'signed-in' || requested.current) return;
    requested.current = true;
    void (async () => {
      try {
        const { data } = await api.checkout.quote();
        setQuote(data);
      } catch (caught) {
        setError(caught instanceof ApiError ? (caught.detail ?? caught.message) : 'Hisob-kitob ochilmadi.');
      }
    })();
  }, [api, status]);

  async function placeOrder(): Promise<void> {
    if (!quote) return;
    setPlacing(true);
    setError(null);
    try {
      await api.orders.create(quote.quoteId, idempotencyKey.current);
      router.push('/buyurtmalarim');
    } catch (caught) {
      setError(
        caught instanceof ApiError ? (caught.detail ?? caught.message) : 'Buyurtma berilmadi.',
      );
      setPlacing(false);
    }
  }

  if (status === 'signed-out') {
    router.push('/kirish');
    return null;
  }

  return (
    <main className="mx-auto w-full max-w-2xl px-5 pb-24 pt-10 sm:px-8">
      <h1 className="mb-8 font-display text-3xl font-bold text-ink dark:text-paper">
        Buyurtmani tasdiqlash
      </h1>

      {error ? (
        <p role="alert" className="mb-6 rounded-stall bg-pomegranate/10 px-3 py-2 font-body text-sm text-pomegranate">
          {error}
        </p>
      ) : null}

      {!quote ? (
        <p className="font-body text-sm text-ink/50 dark:text-paper/50">Hisob-kitob tayyorlanmoqda…</p>
      ) : (
        <>
          {quote.groups.map((group) => (
            <section
              key={group.shopId}
              className="mb-5 rounded-stall border border-ink/10 bg-white/60 p-4 dark:border-paper/10 dark:bg-paper/5"
            >
              <h2 className="font-display text-base font-medium text-ink dark:text-paper">
                {group.shopName}
              </h2>
              <p className="mt-0.5 font-body text-xs text-ink/55 dark:text-paper/55">
                {group.marketName}
              </p>

              <ul className="mt-4 space-y-2">
                {group.lines.map((line) => (
                  <li key={line.lineId} className="flex items-baseline justify-between gap-4">
                    <span className="font-body text-sm text-ink dark:text-paper">
                      {line.name}
                      <span className="ml-2 text-ink/50 dark:text-paper/50">
                        {line.qty.value} {line.qty.unit}
                      </span>
                    </span>
                    <span className="shrink-0 font-body text-sm tabular-nums text-ink dark:text-paper">
                      {formatSom(line.lineTotal.amount)}
                    </span>
                  </li>
                ))}
              </ul>

              {/*
                The pickup window is the promise the buyer is actually accepting, and the
                tolerance is the one detail that causes arguments at handover if it is not
                said in advance (ADR-0006).
              */}
              <p className="mt-4 font-body text-xs text-ink/55 dark:text-paper/55">
                Olib ketish: {new Date(group.pickupWindow.from).toLocaleTimeString('uz', { hour: '2-digit', minute: '2-digit' })}
                {' – '}
                {new Date(group.pickupWindow.to).toLocaleTimeString('uz', { hour: '2-digit', minute: '2-digit' })}
              </p>
              <p className="mt-1 font-body text-xs text-ink/55 dark:text-paper/55">
                Og'irlik ±{group.lines[0]?.tolerancePercent ?? 0}% farq qilishi mumkin — to'lov
                tortilgan og'irlik bo'yicha.
              </p>
            </section>
          ))}

          <div className="mt-8 border-t border-ink/10 pt-6 dark:border-paper/10">
            <div className="flex items-baseline justify-between">
              <span className="font-body text-sm text-ink/60 dark:text-paper/60">Jami</span>
              <span className="font-display text-2xl font-bold tabular-nums text-ink dark:text-paper">
                {formatSom(quote.grandTotal.amount)} so'm
              </span>
            </div>

            <button
              type="button"
              onClick={() => void placeOrder()}
              disabled={placing || quote.issues.length > 0}
              className="mt-5 w-full rounded-stall bg-tile px-4 py-3 font-display text-sm font-medium text-paper hover:bg-tile-deep disabled:opacity-60"
            >
              {placing ? 'Yuborilmoqda…' : 'Buyurtma berish'}
            </button>

            <p className="mt-3 text-center font-body text-xs text-ink/50 dark:text-paper/50">
              To'lov do'konda, olib ketishda.
            </p>
          </div>
        </>
      )}
    </main>
  );
}
