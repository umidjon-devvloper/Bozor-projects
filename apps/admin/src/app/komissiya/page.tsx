'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@bozorlar/api-client';
import type { CommissionRule } from '@bozorlar/api-client';
import { useApi, useSession } from '@bozorlar/session';

/**
 * Commission rules.
 *
 * This page exists because of a specific, live problem: no rule has ever been entered, so every
 * completed order is recorded with `NO_APPLICABLE_RULE` and the platform has charged nothing.
 * A rule here is the first thing that turns completed sales into revenue.
 *
 * Rules are never edited. A rate is entered with a date it takes effect from, and the most
 * specific rule that is in force wins — shop over market over category over platform, then
 * priority, then most recent. That means correcting a rate is entering a new one, and the old
 * one stays as the record of what was charged while it applied. An editable rate would quietly
 * rewrite what a seller was billed last month.
 */

const SCOPES = [
  { value: 'PLATFORM', label: 'Butun platforma' },
  { value: 'MARKET', label: 'Bitta bozor' },
  { value: 'CATEGORY', label: 'Bitta kategoriya' },
  { value: 'SHOP', label: "Bitta do'kon" },
];

const SCOPE_LABEL: Record<string, string> = Object.fromEntries(
  SCOPES.map((scope) => [scope.value, scope.label]),
);

export default function CommissionPage() {
  const api = useApi();
  const { status } = useSession();
  const queryClient = useQueryClient();

  const rules = useQuery({
    queryKey: ['commission-rules'],
    queryFn: () => api.admin.commissionRules.list().then((response) => response.data),
    enabled: status === 'signed-in',
  });

  const [scope, setScope] = useState('PLATFORM');
  const [scopeId, setScopeId] = useState('');
  const [percent, setPercent] = useState('3');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => {
      // Basis points, integers only: 3% is 300. A percentage held as a float is a rate that
      // rounds differently on two machines.
      const bp = Math.round(Number(percent.replace(',', '.')) * 100);
      return api.admin.commissionRules.create({
        scope,
        scopeId: scope === 'PLATFORM' ? null : scopeId.trim(),
        percentBp: bp,
        priority: 0,
        effectiveFrom: new Date().toISOString(),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
    },
    onSuccess: () => {
      setError(null);
      setNote('');
      void queryClient.invalidateQueries({ queryKey: ['commission-rules'] });
    },
    onError: (caught) =>
      setError(caught instanceof ApiError ? (caught.detail ?? caught.message) : 'Saqlanmadi.'),
  });

  if (status === 'signed-out') {
    return <Shell><a href="/kirish" className="font-body text-sm text-tile hover:underline">Kirish</a></Shell>;
  }

  const percentValue = Number(percent.replace(',', '.'));
  const valid =
    Number.isFinite(percentValue) &&
    percentValue >= 0 &&
    percentValue <= 100 &&
    (scope === 'PLATFORM' || /^[a-f0-9]{24}$/.test(scopeId.trim()));

  return (
    <Shell>
      {rules.data?.length === 0 ? (
        <p
          role="alert"
          className="mb-8 rounded-stall border border-pomegranate/30 bg-pomegranate/5 px-4 py-3 font-body text-sm text-pomegranate"
        >
          Bitta ham qoida yo'q. Ya'ni hozircha hech qanday buyurtmadan komissiya olinmayapti.
        </p>
      ) : null}

      <section className="mb-12 rounded-stall border border-ink/10 bg-white/60 p-5 dark:border-paper/10 dark:bg-paper/5">
        <h2 className="mb-4 font-display text-base font-medium text-ink dark:text-paper">
          Yangi qoida
        </h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block font-body text-xs text-ink/60 dark:text-paper/60">
              Qamrov
            </span>
            <select
              value={scope}
              onChange={(event) => setScope(event.target.value)}
              className="w-full rounded-stall border border-ink/15 bg-white px-3 py-2.5 font-body text-sm text-ink dark:border-paper/15 dark:bg-paper/5 dark:text-paper"
            >
              {SCOPES.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1.5 block font-body text-xs text-ink/60 dark:text-paper/60">
              Stavka (%)
            </span>
            <input
              value={percent}
              onChange={(event) => setPercent(event.target.value)}
              inputMode="decimal"
              className="w-full rounded-stall border border-ink/15 bg-white px-3 py-2.5 text-right font-display text-sm tabular-nums text-ink dark:border-paper/15 dark:bg-paper/5 dark:text-paper"
            />
          </label>

          {scope !== 'PLATFORM' ? (
            <label className="block sm:col-span-2">
              <span className="mb-1.5 block font-body text-xs text-ink/60 dark:text-paper/60">
                {SCOPE_LABEL[scope]} ID
              </span>
              <input
                value={scopeId}
                onChange={(event) => setScopeId(event.target.value)}
                placeholder="24 belgili identifikator"
                className="w-full rounded-stall border border-ink/15 bg-white px-3 py-2.5 font-body text-sm tabular-nums text-ink placeholder:text-ink/30 dark:border-paper/15 dark:bg-paper/5 dark:text-paper"
              />
            </label>
          ) : null}

          <label className="block sm:col-span-2">
            <span className="mb-1.5 block font-body text-xs text-ink/60 dark:text-paper/60">
              Izoh
            </span>
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Nima uchun bu stavka"
              className="w-full rounded-stall border border-ink/15 bg-white px-3 py-2.5 font-body text-sm text-ink placeholder:text-ink/30 dark:border-paper/15 dark:bg-paper/5 dark:text-paper"
            />
          </label>
        </div>

        {error ? (
          <p role="alert" className="mt-4 font-body text-sm text-pomegranate">{error}</p>
        ) : null}

        <p className="mt-4 font-body text-xs leading-relaxed text-ink/55 dark:text-paper/55">
          Qoida hozirdan boshlab kuchga kiradi va o'zgartirilmaydi — stavkani to'g'rilash uchun
          yangi qoida kiritiladi, eskisi esa o'sha davrda nima olinganining yozuvi bo'lib qoladi.
        </p>

        <button
          type="button"
          onClick={() => create.mutate()}
          disabled={!valid || create.isPending}
          className="mt-5 rounded-stall bg-tile px-4 py-2.5 font-display text-sm text-paper hover:bg-tile-deep disabled:opacity-50"
        >
          {create.isPending ? 'Saqlanmoqda…' : 'Qoidani kiritish'}
        </button>
      </section>

      <h2 className="mb-4 font-display text-base font-medium text-ink dark:text-paper">
        Amaldagi qoidalar
      </h2>

      {rules.isPending ? (
        <p className="font-body text-sm text-ink/50 dark:text-paper/50">Yuklanmoqda…</p>
      ) : rules.isError || !rules.data ? (
        <p role="alert" className="font-body text-sm text-pomegranate">Qoidalarni ochib bo'lmadi.</p>
      ) : rules.data.length === 0 ? (
        <p className="font-body text-sm text-ink/55 dark:text-paper/55">Ro'yxat bo'sh.</p>
      ) : (
        <ul className="divide-y divide-ink/10 dark:divide-paper/10">
          {rules.data.map((rule) => (
            <RuleRow key={rule.id} rule={rule} />
          ))}
        </ul>
      )}
    </Shell>
  );
}

function RuleRow({ rule }: { rule: CommissionRule }) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-3 py-3">
      <div className="min-w-0">
        <span className="font-body text-sm text-ink dark:text-paper">
          {SCOPE_LABEL[rule.scope] ?? rule.scope}
        </span>
        {rule.note ? (
          <span className="ml-2 font-body text-xs text-ink/50 dark:text-paper/50">{rule.note}</span>
        ) : null}
        <p className="mt-0.5 font-body text-xs text-ink/45 dark:text-paper/45">
          {new Date(rule.effectiveFrom).toLocaleDateString('uz')} dan
          {rule.effectiveTo ? ` ${new Date(rule.effectiveTo).toLocaleDateString('uz')} gacha` : ''}
        </p>
      </div>
      <span className="font-display text-lg tabular-nums text-ink dark:text-paper">
        {(rule.percentBp / 100).toFixed(2)}%
      </span>
    </li>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-3xl px-5 pb-24 pt-8 sm:px-8">
      <h1 className="mb-8 font-display text-2xl font-bold text-ink dark:text-paper">Komissiya</h1>
      {children}
    </main>
  );
}
