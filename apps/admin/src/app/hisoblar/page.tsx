'use client';

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, formatSom } from '@bozorlar/api-client';
import { useApi, useSession } from '@bozorlar/session';

/**
 * A seller's wallet, and the manual movements against it.
 *
 * This page matters more than it looks. No merchant contract is signed, so Payme and Click
 * cannot take money yet — which makes a manual credit here the *only* way a seller's stall
 * comes back after their balance runs out. The seller dashboard says "top-ups go through an
 * administrator"; this is that administrator.
 *
 * It is deliberately not a list. A wallet is looked up by the seller who telephoned about it,
 * and a browsable table of everyone's balance is a page that invites idle reading of other
 * people's money.
 */
export default function WalletPage() {
  const api = useApi();
  const { status } = useSession();
  const queryClient = useQueryClient();

  const [sellerId, setSellerId] = useState('');
  const [lookedUp, setLookedUp] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [direction, setDirection] = useState<'CREDIT' | 'DEBIT'>('CREDIT');
  const [reason, setReason] = useState('');
  const [approvedBy, setApprovedBy] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const wallet = useQuery({
    queryKey: ['admin-wallet', lookedUp],
    queryFn: () => api.admin.wallet(lookedUp ?? '').then((response) => response.data),
    enabled: status === 'signed-in' && lookedUp !== null,
  });

  const reconcile = useMutation({
    mutationFn: () => api.admin.reconcileWallet(lookedUp ?? ''),
    onSuccess: (response) =>
      setDone(
        response.data.matches
          ? 'Balans daftar bilan mos keldi.'
          : `Mos kelmadi: saqlangan ${formatSom(response.data.stored.amount)}, hisoblangan ${formatSom(response.data.computed.amount)}.`,
      ),
    onError: (caught) =>
      setError(caught instanceof ApiError ? (caught.detail ?? caught.message) : 'Bajarilmadi.'),
  });

  /**
   * One key per form, regenerated only after a successful write.
   *
   * A retry after a timeout must carry the key of the attempt it is retrying, or the server
   * treats it as a new adjustment and moves the money twice — which on this page means real
   * money, since manual credits are the only way to top a seller up today.
   */
  const requestKey = useRef(crypto.randomUUID());

  const adjust = useMutation({
    mutationFn: () =>
      api.admin.adjust({
        sellerId: lookedUp ?? '',
        // Som in, tiyin out. A wallet is topped up in whole som at a bazaar.
        amount: (BigInt(amount.replace(/\D/g, '') || '0') * 100n).toString(),
        direction,
        reason: reason.trim(),
        ...(approvedBy.trim() ? { approvedBy: approvedBy.trim() } : {}),
      }, requestKey.current),
    onSuccess: () => {
      setAmount('');
      setReason('');
      setApprovedBy('');
      setError(null);
      setDone('Yozuv kiritildi.');
      // The next adjustment is a new attempt and must not reuse this one's key.
      requestKey.current = crypto.randomUUID();
      void queryClient.invalidateQueries({ queryKey: ['admin-wallet', lookedUp] });
    },
    onError: (caught) =>
      setError(caught instanceof ApiError ? (caught.detail ?? caught.message) : 'Bajarilmadi.'),
  });

  if (status === 'signed-out') {
    return <Shell><a href="/kirish" className="font-body text-sm text-tile hover:underline">Kirish</a></Shell>;
  }

  const valid = /^\d+$/.test(amount.replace(/\s/g, '')) && reason.trim().length >= 10;

  return (
    <Shell>
      <div className="mb-8 flex flex-wrap gap-2">
        <input
          value={sellerId}
          onChange={(event) => setSellerId(event.target.value)}
          placeholder="Sotuvchi ID (24 belgi)"
          aria-label="Sotuvchi identifikatori"
          className="w-full max-w-sm rounded-stall border border-ink/15 bg-white px-3 py-2.5 font-body text-sm tabular-nums text-ink placeholder:text-ink/30 dark:border-paper/15 dark:bg-paper/5 dark:text-paper"
        />
        <button
          type="button"
          onClick={() => {
            setLookedUp(sellerId.trim());
            setError(null);
            setDone(null);
          }}
          disabled={!/^[a-f0-9]{24}$/.test(sellerId.trim())}
          className="rounded-stall bg-tile px-4 py-2.5 font-display text-sm text-paper hover:bg-tile-deep disabled:opacity-50"
        >
          Topish
        </button>
      </div>

      {lookedUp === null ? (
        <p className="font-body text-sm text-ink/55 dark:text-paper/55">
          Hisobni ko'rish uchun sotuvchi identifikatorini kiriting.
        </p>
      ) : wallet.isPending ? (
        <p className="font-body text-sm text-ink/50 dark:text-paper/50">Yuklanmoqda…</p>
      ) : wallet.isError || !wallet.data ? (
        <p role="alert" className="font-body text-sm text-pomegranate">Hisob topilmadi.</p>
      ) : (
        <>
          <div className="rounded-stall border border-ink/10 bg-white/60 p-5 dark:border-paper/10 dark:bg-paper/5">
            <p className="font-body text-xs uppercase tracking-wider text-ink/50 dark:text-paper/50">
              Balans · {wallet.data.state}
            </p>
            <p className="mt-2 font-display text-3xl font-bold tabular-nums text-ink dark:text-paper">
              {formatSom(wallet.data.balance.amount)} so'm
            </p>
            <dl className="mt-5 grid gap-3 font-body text-sm sm:grid-cols-3">
              <Pair label="Ogohlantirish chegarasi" value={`${formatSom(wallet.data.lowBalanceThreshold.amount)} so'm`} />
              <Pair label="O'chirish chegarasi" value={`${formatSom(wallet.data.deactivateBelow.amount)} so'm`} />
              <Pair label="Jami olingan komissiya" value={`${formatSom(wallet.data.lifetimeCharged.amount)} so'm`} />
            </dl>

            <button
              type="button"
              onClick={() => reconcile.mutate()}
              disabled={reconcile.isPending}
              className="mt-5 rounded-stall border border-ink/15 px-3.5 py-2 font-body text-sm text-ink/70 hover:text-tile disabled:opacity-50 dark:border-paper/15 dark:text-paper/70"
            >
              {reconcile.isPending ? '…' : 'Daftar bilan solishtirish'}
            </button>
          </div>

          {/*
            Every movement here is money. The reason is required and stored, because a balance
            that changed with no recorded explanation is indistinguishable from a mistake or a
            theft when somebody audits it a year later.
          */}
          <section className="mt-10 rounded-stall border border-ink/10 p-5 dark:border-paper/10">
            <h2 className="mb-4 font-display text-base font-medium text-ink dark:text-paper">
              Qo'lda yozuv
            </h2>

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1.5 block font-body text-xs text-ink/60 dark:text-paper/60">Yo'nalish</span>
                <select
                  value={direction}
                  onChange={(event) => setDirection(event.target.value as 'CREDIT' | 'DEBIT')}
                  className="w-full rounded-stall border border-ink/15 bg-white px-3 py-2.5 font-body text-sm text-ink dark:border-paper/15 dark:bg-paper/5 dark:text-paper"
                >
                  <option value="CREDIT">To'ldirish</option>
                  <option value="DEBIT">Yechish</option>
                </select>
              </label>

              <label className="block">
                <span className="mb-1.5 block font-body text-xs text-ink/60 dark:text-paper/60">Summa (so'm)</span>
                <input
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  inputMode="numeric"
                  className="w-full rounded-stall border border-ink/15 bg-white px-3 py-2.5 text-right font-display text-sm tabular-nums text-ink dark:border-paper/15 dark:bg-paper/5 dark:text-paper"
                />
              </label>

              <label className="block sm:col-span-2">
                <span className="mb-1.5 block font-body text-xs text-ink/60 dark:text-paper/60">
                  Sabab
                </span>
                <input
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="Nima uchun — bu yozuv saqlanadi"
                  className="w-full rounded-stall border border-ink/15 bg-white px-3 py-2.5 font-body text-sm text-ink placeholder:text-ink/30 dark:border-paper/15 dark:bg-paper/5 dark:text-paper"
                />
              </label>

              <label className="block sm:col-span-2">
                <span className="mb-1.5 block font-body text-xs text-ink/60 dark:text-paper/60">
                  Tasdiqlovchi administrator ID (katta summalar uchun)
                </span>
                <input
                  value={approvedBy}
                  onChange={(event) => setApprovedBy(event.target.value)}
                  placeholder="Bo'sh qoldirsa ham bo'ladi"
                  className="w-full rounded-stall border border-ink/15 bg-white px-3 py-2.5 font-body text-sm tabular-nums text-ink placeholder:text-ink/30 dark:border-paper/15 dark:bg-paper/5 dark:text-paper"
                />
              </label>
            </div>

            <p className="mt-4 font-body text-xs leading-relaxed text-ink/55 dark:text-paper/55">
              Katta summalar ikkinchi administrator tasdig'ini talab qiladi va o'zini o'zi
              tasdiqlab bo'lmaydi — buni server tekshiradi.
            </p>

            {error ? <p role="alert" className="mt-3 font-body text-sm text-pomegranate">{error}</p> : null}
            {done ? <p className="mt-3 font-body text-sm text-tile dark:text-tile-light">{done}</p> : null}

            <button
              type="button"
              onClick={() => adjust.mutate()}
              disabled={!valid || adjust.isPending}
              className="mt-5 rounded-stall bg-tile px-4 py-2.5 font-display text-sm text-paper hover:bg-tile-deep disabled:opacity-50"
            >
              {adjust.isPending ? 'Saqlanmoqda…' : 'Yozuvni kiritish'}
            </button>
          </section>
        </>
      )}
    </Shell>
  );
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-ink/45 dark:text-paper/45">{label}</dt>
      <dd className="mt-0.5 tabular-nums text-ink dark:text-paper">{value}</dd>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-2xl px-5 pb-24 pt-8 sm:px-8">
      <h1 className="mb-2 font-display text-2xl font-bold text-ink dark:text-paper">Hisoblar</h1>
      <p className="mb-8 max-w-lg font-body text-sm text-ink/55 dark:text-paper/55">
        To'lov tizimlari hali ulanmagan, shuning uchun sotuvchi hisobini to'ldirishning yagona
        yo'li shu sahifa.
      </p>
      {children}
    </main>
  );
}
