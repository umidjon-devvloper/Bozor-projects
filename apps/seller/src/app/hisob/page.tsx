'use client';

import { useQuery } from '@tanstack/react-query';
import { formatSom } from '@bozorlar/api-client';
import { useApi, useSession } from '@bozorlar/session';

/**
 * The wallet, and what the platform charged for.
 *
 * A seller's wallet is not a bank account they spend from — it is the balance commission is
 * deducted against, and when it runs out their stall disappears from the marketplace. So the
 * page leads with the consequence rather than the number: whether the stall is visible, and how
 * close it is to not being.
 *
 * The statement below comes from the ledger, not from order records, which means it shows what
 * was actually posted including reversals after a dispute. That is the figure a seller can
 * check against their own notes.
 */
export default function AccountPage() {
  const api = useApi();
  const { status } = useSession();

  const wallet = useQuery({
    queryKey: ['seller-wallet'],
    queryFn: () => api.seller.wallet().then((response) => response.data),
    enabled: status === 'signed-in',
  });

  const report = useQuery({
    queryKey: ['seller-report'],
    queryFn: () => api.seller.report().then((response) => response.data),
    enabled: status === 'signed-in',
  });

  if (status === 'signed-out') {
    return <Shell><a href="/kirish" className="font-body text-sm text-saffron-deep hover:underline">Kirish</a></Shell>;
  }
  if (wallet.isPending || status === 'loading') {
    return <Shell><p className="font-body text-sm text-ink/50 dark:text-paper/50">Yuklanmoqda…</p></Shell>;
  }
  if (wallet.isError) {
    return <Shell><p role="alert" className="font-body text-sm text-pomegranate">Hisobni ochib bo'lmadi.</p></Shell>;
  }

  const balance = BigInt(wallet.data.balance.amount);
  const threshold = BigInt(wallet.data.lowBalanceThreshold.amount);
  const floor = BigInt(wallet.data.deactivateBelow.amount);
  const inactive = wallet.data.state === 'INACTIVE';
  const low = !inactive && balance <= threshold;

  return (
    <Shell>
      {/* The state, first, because it is the only thing here that changes what customers see. */}
      <div
        className={
          inactive
            ? 'rounded-stall border border-pomegranate/30 bg-pomegranate/5 p-4'
            : low
              ? 'rounded-stall border border-saffron/40 bg-saffron/10 p-4'
              : 'rounded-stall border border-ink/10 bg-white/60 p-4 dark:border-paper/10 dark:bg-paper/5'
        }
      >
        <p className="font-body text-xs uppercase tracking-wider text-ink/50 dark:text-paper/50">
          Hisob holati
        </p>
        <p className="mt-2 font-display text-3xl font-bold tabular-nums text-ink dark:text-paper">
          {formatSom(wallet.data.balance.amount)} so'm
        </p>

        {inactive ? (
          <p className="mt-3 font-body text-sm text-pomegranate">
            Do'koningiz bozorda ko'rinmayapti. Hisobni to'ldirsangiz mahsulotlaringiz qaytadi.
          </p>
        ) : low ? (
          <p className="mt-3 font-body text-sm text-saffron-deep">
            Balans kamayib qoldi. {formatSom(floor.toString())} so'mdan pastga tushsa, do'kon
            bozordan vaqtincha olib qo'yiladi.
          </p>
        ) : (
          <p className="mt-3 font-body text-sm text-ink/60 dark:text-paper/60">
            Do'koningiz bozorda ko'rinib turibdi.
          </p>
        )}
      </div>

      {/*
        No top-up button yet. The Payme and Click callbacks are implemented but no merchant
        contract is signed, so a button here would start a flow that cannot finish. Saying so is
        better than a control that fails at the last step.
      */}
      <p className="mt-4 font-body text-xs text-ink/50 dark:text-paper/50">
        Hozircha to'ldirish administrator orqali amalga oshiriladi.
      </p>

      <section className="mt-12">
        <h2 className="mb-4 font-display text-base font-medium text-ink dark:text-paper">
          Oxirgi 30 kun
        </h2>

        {report.isPending ? (
          <p className="font-body text-sm text-ink/50 dark:text-paper/50">Hisobot tayyorlanmoqda…</p>
        ) : report.isError || !report.data ? (
          <p className="font-body text-sm text-ink/55 dark:text-paper/55">Hisobot mavjud emas.</p>
        ) : (
          <dl className="grid gap-4 sm:grid-cols-2">
            <Stat label="Yakunlangan buyurtma" value={String(report.data.orders.completed)} />
            <Stat label="Savdo" value={`${formatSom(report.data.gmvMinor)} so'm`} />
            <Stat label="Olingan komissiya" value={`${formatSom(report.data.commissionNetMinor)} so'm`} />
            <Stat
              label="Haqiqiy stavka"
              value={
                report.data.effectiveRateBp === null
                  ? '—'
                  : `${(report.data.effectiveRateBp / 100).toFixed(2)}%`
              }
            />
          </dl>
        )}

        <p className="mt-6 max-w-lg font-body text-xs leading-relaxed text-ink/50 dark:text-paper/50">
          Komissiya buyurtma yozuvidan emas, hisob kitob daftaridan olinadi — ya'ni nizodan keyin
          qaytarilgan summalar ham shu raqamda aks etadi.
        </p>
      </section>
    </Shell>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-stall border border-ink/10 p-4 dark:border-paper/10">
      <dt className="font-body text-xs text-ink/50 dark:text-paper/50">{label}</dt>
      <dd className="mt-1 font-display text-xl tabular-nums text-ink dark:text-paper">{value}</dd>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-2xl px-5 pb-24 pt-8 sm:px-8">
      <h1 className="mb-8 font-display text-2xl font-bold text-ink dark:text-paper">Hisob</h1>
      {children}
    </main>
  );
}
