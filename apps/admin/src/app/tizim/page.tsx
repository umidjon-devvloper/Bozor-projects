'use client';

import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError } from '@bozorlar/api-client';
import { useApi, useSession } from '@bozorlar/session';

/**
 * The search index: whether it is healthy, and rebuilding it when it is not.
 *
 * Search is the one part of the platform that can be silently wrong. The catalogue stays
 * correct in MongoDB while the index drifts — a product edited during an outage, an event the
 * worker never received — and nothing surfaces except shoppers not finding things that exist.
 * So health is shown here rather than being left to be noticed.
 *
 * A rebuild is a background job, not a button that finishes. It is confirmed before starting,
 * because on a large catalogue it costs real time and a second one started impatiently makes
 * the first slower.
 */
export default function SystemPage() {
  const api = useApi();
  const { status } = useSession();
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const health = useQuery({
    queryKey: ['search-health'],
    queryFn: () => api.admin.searchHealth().then((response) => response.data),
    enabled: status === 'signed-in',
  });

  const reindex = useMutation({
    mutationFn: () => api.admin.reindex(),
    onSuccess: () => {
      setConfirming(false);
      setError(null);
      setMessage("Qayta indekslash boshlandi. Bu fonda ishlaydi va biroz vaqt oladi.");
    },
    onError: (caught) =>
      setError(caught instanceof ApiError ? (caught.detail ?? caught.message) : 'Boshlanmadi.'),
  });

  if (status === 'signed-out') {
    return <Shell><a href="/kirish" className="font-body text-sm text-tile hover:underline">Kirish</a></Shell>;
  }

  return (
    <Shell>
      <section className="rounded-stall border border-ink/10 bg-white/60 p-5 dark:border-paper/10 dark:bg-paper/5">
        <h2 className="font-display text-base font-medium text-ink dark:text-paper">Qidiruv indeksi</h2>

        {health.isPending ? (
          <p className="mt-3 font-body text-sm text-ink/50 dark:text-paper/50">Tekshirilmoqda…</p>
        ) : health.isError || !health.data ? (
          <p className="mt-3 font-body text-sm text-pomegranate">
            Indeks holatini o'qib bo'lmadi — qidiruv xizmati javob bermayapti.
          </p>
        ) : (
          <p className="mt-3 font-body text-sm">
            {health.data.healthy ? (
              <span className="text-tile dark:text-tile-light">Indeks ishlayapti</span>
            ) : (
              <span className="text-pomegranate">Indeks nosoz</span>
            )}
          </p>
        )}

        <p className="mt-4 max-w-lg font-body text-xs leading-relaxed text-ink/55 dark:text-paper/55">
          Katalog MongoDB'da to'g'ri turaveradi, indeks esa undan uzoqlashishi mumkin — masalan
          uzilish paytida tahrirlangan mahsulot. Bunday holatda xaridorlar mavjud mahsulotni
          topa olmaydi, boshqa hech qanday belgi bo'lmaydi.
        </p>

        {error ? <p role="alert" className="mt-4 font-body text-sm text-pomegranate">{error}</p> : null}
        {message ? <p className="mt-4 font-body text-sm text-tile dark:text-tile-light">{message}</p> : null}

        {confirming ? (
          <div className="mt-5 rounded-stall border border-saffron/40 bg-saffron/10 p-4">
            <p className="font-body text-sm text-ink dark:text-paper">
              Butun katalog qayta indekslansinmi?
            </p>
            <p className="mt-1 font-body text-xs text-ink/60 dark:text-paper/60">
              Fonda ishlaydi. Katta katalogda uzoq davom etadi va ikkinchisini boshlash
              birinchisini sekinlashtiradi.
            </p>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => reindex.mutate()}
                disabled={reindex.isPending}
                className="rounded-stall bg-tile px-4 py-2 font-display text-sm text-paper hover:bg-tile-deep disabled:opacity-50"
              >
                {reindex.isPending ? '…' : 'Ha, boshlansin'}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded-stall px-3 py-2 font-body text-sm text-ink/60 dark:text-paper/60"
              >
                Bekor qilish
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="mt-5 rounded-stall border border-ink/15 px-3.5 py-2 font-body text-sm text-ink/70 hover:text-tile dark:border-paper/15 dark:text-paper/70"
          >
            Qayta indekslash
          </button>
        )}
      </section>

      <ReviewModeration />
    </Shell>
  );
}

/**
 * Hiding a review, by id.
 *
 * Deliberately a lookup rather than a queue, because there is nothing to queue: the platform
 * has no way for anybody to report a review, so a moderator only ever arrives here holding an
 * id from a complaint that came by telephone. Building a browsable list of reviews to police
 * would invite moderating opinions nobody objected to.
 *
 * The reason is required and stored on the review itself — the model refuses a hidden review
 * without one, which is the right rule: hiding somebody's words with no recorded justification
 * is not moderation, it is deletion.
 */
function ReviewModeration() {
  const api = useApi();
  const [reviewId, setReviewId] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const hide = useMutation({
    mutationFn: () => api.admin.moderateReview(reviewId.trim(), true, reason.trim()),
    onSuccess: () => {
      setReviewId('');
      setReason('');
      setError(null);
      setDone(true);
    },
    onError: (caught) =>
      setError(caught instanceof ApiError ? (caught.detail ?? caught.message) : 'Bajarilmadi.'),
  });

  const valid = /^[a-f0-9]{24}$/.test(reviewId.trim()) && reason.trim().length >= 5;

  return (
    <section className="mt-10 rounded-stall border border-ink/10 p-5 dark:border-paper/10">
      <h2 className="font-display text-base font-medium text-ink dark:text-paper">
        Sharhni yashirish
      </h2>
      <p className="mt-2 max-w-lg font-body text-xs leading-relaxed text-ink/55 dark:text-paper/55">
        Sharhlar uchun navbat yo'q — shikoyat kelganda identifikator bo'yicha ochiladi. Sabab
        sharhning o'zida saqlanadi.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <input
          value={reviewId}
          onChange={(event) => setReviewId(event.target.value)}
          placeholder="Sharh ID"
          className="w-full rounded-stall border border-ink/15 bg-white px-3 py-2.5 font-body text-sm tabular-nums text-ink placeholder:text-ink/30 dark:border-paper/15 dark:bg-paper/5 dark:text-paper"
        />
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Nima uchun yashirilyapti"
          className="w-full rounded-stall border border-ink/15 bg-white px-3 py-2.5 font-body text-sm text-ink placeholder:text-ink/30 dark:border-paper/15 dark:bg-paper/5 dark:text-paper"
        />
      </div>

      {error ? <p role="alert" className="mt-3 font-body text-sm text-pomegranate">{error}</p> : null}
      {done ? <p className="mt-3 font-body text-sm text-tile dark:text-tile-light">Yashirildi.</p> : null}

      <button
        type="button"
        onClick={() => hide.mutate()}
        disabled={!valid || hide.isPending}
        className="mt-4 rounded-stall border border-pomegranate/30 px-3.5 py-2 font-body text-sm text-pomegranate hover:bg-pomegranate/5 disabled:opacity-50"
      >
        {hide.isPending ? '…' : 'Yashirish'}
      </button>
    </section>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-2xl px-5 pb-24 pt-8 sm:px-8">
      <h1 className="mb-8 font-display text-2xl font-bold text-ink dark:text-paper">Tizim</h1>
      {children}
    </main>
  );
}
