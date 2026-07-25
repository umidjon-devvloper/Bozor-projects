'use client';

import { useQuery } from '@tanstack/react-query';
import { formatSom } from '@bozorlar/api-client';
import type { QueueDepth } from '@bozorlar/api-client';
import { useApi, useSession } from '@bozorlar/session';

/**
 * What needs a person, and how the platform is doing — in that order.
 *
 * Queues lead because they are the only thing on this page anybody has to act on. A report tells
 * an administrator how last month went; a queue tells them somebody is waiting right now, and a
 * seller blocked on an unreviewed application is not trading.
 *
 * Each queue shows its depth beside the age of its oldest item, because depth alone is not a
 * state of the world. Two applications where one has waited five days is worse than forty
 * opened this morning, and only the second number distinguishes them.
 */
export default function DashboardPage() {
  const api = useApi();
  const { status } = useSession();

  const queues = useQuery({
    queryKey: ['moderation'],
    queryFn: () => api.admin.moderation().then((response) => response.data),
    enabled: status === 'signed-in',
  });

  const overview = useQuery({
    queryKey: ['overview'],
    queryFn: () => api.admin.overview().then((response) => response.data),
    enabled: status === 'signed-in',
  });

  if (status === 'loading') return <Shell><Muted>Yuklanmoqda…</Muted></Shell>;
  if (status === 'signed-out') {
    return (
      <Shell>
        <p className="font-body text-sm text-ink/70 dark:text-paper/70">
          Administrator hisobi bilan kiring.
        </p>
        <a href="/kirish" className="mt-4 inline-block rounded-stall bg-tile px-4 py-2.5 font-display text-sm text-paper hover:bg-tile-deep">
          Kirish
        </a>
      </Shell>
    );
  }

  return (
    <Shell>
      <section className="mb-14">
        <h2 className="mb-4 font-display text-base font-medium text-ink dark:text-paper">
          Navbatlar
        </h2>
        {queues.isPending ? (
          <Muted>Navbatlar yuklanmoqda…</Muted>
        ) : queues.isError || !queues.data ? (
          <p role="alert" className="font-body text-sm text-pomegranate">Navbatlarni ochib bo'lmadi.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-3">
            <Queue title="Mahsulot moderatsiyasi" depth={queues.data.products} />
            <Queue title="Sotuvchi arizalari" depth={queues.data.sellerApplications} />
            <Queue title="Ochiq nizolar" depth={queues.data.disputes} />
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-1 font-display text-base font-medium text-ink dark:text-paper">
          Oxirgi 30 kun
        </h2>
        <p className="mb-5 font-body text-xs text-ink/50 dark:text-paper/50">
          Oldingi 30 kun bilan solishtirilgan.
        </p>

        {overview.isPending ? (
          <Muted>Hisobot tayyorlanmoqda…</Muted>
        ) : overview.isError || !overview.data ? (
          <p role="alert" className="font-body text-sm text-pomegranate">Hisobotni ochib bo'lmadi.</p>
        ) : (
          <>
            <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label="Savdo hajmi"
                value={`${formatSom(overview.data.money.gmvMinor)} so'm`}
                changeBp={overview.data.change.gmvBp}
              />
              <Stat
                label="Komissiya"
                value={`${formatSom(overview.data.money.commissionNetMinor)} so'm`}
                changeBp={overview.data.change.commissionBp}
              />
              <Stat label="Yakunlangan buyurtma" value={String(overview.data.orders.completed)} />
              <Stat
                label="Yakunlanish darajasi"
                value={
                  overview.data.orders.completionRateBp === null
                    ? '—'
                    : `${(overview.data.orders.completionRateBp / 100).toFixed(1)}%`
                }
              />
            </dl>

            {/*
              The one number that reveals a broken commission setup. If sales happened and the
              effective rate is zero, no rule matched and every completed order was recorded as
              NO_APPLICABLE_RULE — money the platform earned and did not charge.
            */}
            {BigInt(overview.data.money.gmvMinor) > 0n &&
            overview.data.money.commissionNetMinor === '0' ? (
              <p
                role="alert"
                className="mt-6 rounded-stall border border-pomegranate/30 bg-pomegranate/5 px-4 py-3 font-body text-sm text-pomegranate"
              >
                Savdo bo'lgan, lekin komissiya olinmagan. Ehtimol bitta ham komissiya qoidasi
                kiritilmagan — har bir yakunlangan buyurtma qoidasiz yozilmoqda.
              </p>
            ) : null}

            <dl className="mt-8 grid gap-3 sm:grid-cols-3">
              <Stat label="Yangi foydalanuvchi" value={String(overview.data.participation.newUsers)} />
              <Stat label="Savdo qilgan do'kon" value={String(overview.data.participation.activeSellers)} />
              <Stat
                label="Haqiqiy stavka"
                value={
                  overview.data.money.effectiveRateBp === null
                    ? '—'
                    : `${(overview.data.money.effectiveRateBp / 100).toFixed(2)}%`
                }
              />
            </dl>
          </>
        )}
      </section>
    </Shell>
  );
}

function Queue({ title, depth }: { title: string; depth: QueueDepth }) {
  const stale = depth.stale > 0;
  return (
    <div
      className={
        stale
          ? 'rounded-stall border border-pomegranate/30 bg-pomegranate/5 p-4'
          : 'rounded-stall border border-ink/10 bg-white/60 p-4 dark:border-paper/10 dark:bg-paper/5'
      }
    >
      <p className="font-body text-xs text-ink/55 dark:text-paper/55">{title}</p>
      <p className="mt-2 font-display text-3xl font-bold tabular-nums text-ink dark:text-paper">
        {depth.pending}
      </p>
      {depth.oldestWaitingHours !== null ? (
        <p className={stale ? 'mt-2 font-body text-xs text-pomegranate' : 'mt-2 font-body text-xs text-ink/50 dark:text-paper/50'}>
          Eng eskisi {depth.oldestWaitingHours} soat kutmoqda
          {stale ? ` · ${depth.stale} tasi kechikkan` : ''}
        </p>
      ) : (
        <p className="mt-2 font-body text-xs text-ink/45 dark:text-paper/45">Navbat bo'sh</p>
      )}
    </div>
  );
}

function Stat({ label, value, changeBp }: { label: string; value: string; changeBp?: number | null }) {
  return (
    <div className="rounded-stall border border-ink/10 p-4 dark:border-paper/10">
      <dt className="font-body text-xs text-ink/50 dark:text-paper/50">{label}</dt>
      <dd className="mt-1 font-display text-xl tabular-nums text-ink dark:text-paper">{value}</dd>
      {changeBp !== undefined && changeBp !== null ? (
        <p
          className={
            changeBp >= 0
              ? 'mt-1 font-body text-xs text-tile'
              : 'mt-1 font-body text-xs text-pomegranate'
          }
        >
          {changeBp >= 0 ? '+' : ''}
          {(changeBp / 100).toFixed(1)}%
        </p>
      ) : null}
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p className="font-body text-sm text-ink/50 dark:text-paper/50">{children}</p>;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-5xl px-5 pb-24 pt-8 sm:px-8">
      <h1 className="mb-8 font-display text-2xl font-bold text-ink dark:text-paper">
        Ko'rsatkichlar
      </h1>
      {children}
    </main>
  );
}
