'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, localized } from '@bozorlar/api-client';
import type { CategoryNode } from '@bozorlar/api-client';
import { Locale } from '@bozorlar/types';
import { useApi, useSession } from '@bozorlar/session';

/**
 * The reference data everything else hangs off: markets and categories.
 *
 * Edited rarely — after seeding, a new bazaar appears perhaps once a season — but wrongly here
 * is wrong everywhere. A market with the wrong coordinates puts every stall in it at the wrong
 * place on the map; a category with the wrong default unit makes every product added under it
 * sell by the wrong measure.
 *
 * So the forms are deliberately unhurried: every field visible, nothing behind a step, and no
 * defaults that could be accepted without being read.
 */
export default function ReferencePage() {
  const { status } = useSession();

  if (status === 'signed-out') {
    return <Shell><a href="/kirish" className="font-body text-sm text-tile hover:underline">Kirish</a></Shell>;
  }

  return (
    <Shell>
      <MarketSection />
      <CategorySection />
    </Shell>
  );
}

const WEEKDAYS = ['Yakshanba', 'Dushanba', 'Seshanba', 'Chorshanba', 'Payshanba', 'Juma', 'Shanba'];

/** Seven entries, one per weekday, because the API requires exactly that and rejects fewer. */
function defaultHours() {
  return WEEKDAYS.map((_, weekday) => ({
    weekday,
    opensAt: '07:00',
    closesAt: '19:00',
    isClosed: false,
  }));
}

function MarketSection() {
  const api = useApi();
  const queryClient = useQueryClient();

  const [districtId, setDistrictId] = useState('');
  const [nameUz, setNameUz] = useState('');
  const [addressUz, setAddressUz] = useState('');
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [hours, setHours] = useState(defaultHours);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const markets = useQuery({
    queryKey: ['admin-markets'],
    queryFn: () => api.markets.list({ limit: 100 }).then((response) => response.data),
  });

  const create = useMutation({
    mutationFn: () =>
      api.admin.createMarket({
        districtId: districtId.trim(),
        name: { uz: nameUz.trim() },
        address: { uz: addressUz.trim() },
        location: { lat: Number(lat), lng: Number(lng) },
        workingHours: hours,
      }),
    onSuccess: () => {
      setNameUz('');
      setAddressUz('');
      setLat('');
      setLng('');
      setError(null);
      setDone(true);
      void queryClient.invalidateQueries({ queryKey: ['admin-markets'] });
    },
    onError: (caught) =>
      setError(caught instanceof ApiError ? (caught.detail ?? caught.message) : 'Saqlanmadi.'),
  });

  const setStatus = useMutation({
    mutationFn: (input: { id: string; status: string }) =>
      api.admin.setMarketStatus(input.id, input.status),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-markets'] }),
    onError: (caught) =>
      setError(caught instanceof ApiError ? (caught.detail ?? caught.message) : 'Bajarilmadi.'),
  });

  const valid =
    /^[a-f0-9]{24}$/.test(districtId.trim()) &&
    nameUz.trim().length > 1 &&
    addressUz.trim().length > 1 &&
    Number.isFinite(Number(lat)) &&
    Number.isFinite(Number(lng)) &&
    lat.trim() !== '' &&
    lng.trim() !== '';

  return (
    <section className="mb-16">
      <h2 className="mb-4 font-display text-lg font-medium text-ink dark:text-paper">Bozorlar</h2>

      {markets.isPending ? (
        <p className="font-body text-sm text-ink/50 dark:text-paper/50">Yuklanmoqda…</p>
      ) : markets.isError || !markets.data ? (
        <p role="alert" className="font-body text-sm text-pomegranate">Ro'yxatni ochib bo'lmadi.</p>
      ) : (
        <ul className="mb-8 divide-y divide-ink/10 dark:divide-paper/10">
          {markets.data.map((market) => (
            <li key={market.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="font-body text-sm text-ink dark:text-paper">
                  {localized(market.name, Locale.UZ_LATN)}
                </p>
                <p className="mt-0.5 font-body text-xs text-ink/50 dark:text-paper/50">
                  {market.status} · {market.shopCount} do'kon
                </p>
              </div>
              {/*
                Closing a market hides every stall inside it at once. It is one click and it is
                not undoable by the seller, so the label says what it does rather than naming a
                status code.
              */}
              <button
                type="button"
                onClick={() =>
                  setStatus.mutate({
                    id: market.id,
                    status: market.status === 'ACTIVE' ? 'CLOSED' : 'ACTIVE',
                  })
                }
                disabled={setStatus.isPending}
                className="shrink-0 rounded-stall border border-ink/15 px-3 py-1.5 font-body text-xs text-ink/70 hover:text-tile disabled:opacity-50 dark:border-paper/15 dark:text-paper/70"
              >
                {market.status === 'ACTIVE' ? "Bozorni yopish" : 'Bozorni ochish'}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="rounded-stall border border-ink/10 p-5 dark:border-paper/10">
        <h3 className="mb-4 font-display text-base font-medium text-ink dark:text-paper">
          Yangi bozor
        </h3>

        <div className="grid gap-4 sm:grid-cols-2">
          <Text label="Tuman ID" value={districtId} onChange={setDistrictId} mono />
          <Text label="Nomi (o'zbekcha)" value={nameUz} onChange={setNameUz} />
          <Text label="Manzil (o'zbekcha)" value={addressUz} onChange={setAddressUz} />
          <div className="grid grid-cols-2 gap-3">
            <Text label="Kenglik" value={lat} onChange={setLat} mono />
            <Text label="Uzunlik" value={lng} onChange={setLng} mono />
          </div>
        </div>

        <fieldset className="mt-6">
          <legend className="mb-3 font-body text-xs text-ink/60 dark:text-paper/60">Ish vaqti</legend>
          <div className="space-y-2">
            {hours.map((entry, index) => (
              <div key={entry.weekday} className="flex flex-wrap items-center gap-3">
                <span className="w-24 font-body text-sm text-ink/70 dark:text-paper/70">
                  {WEEKDAYS[entry.weekday]}
                </span>
                <label className="flex items-center gap-1.5 font-body text-xs text-ink/60 dark:text-paper/60">
                  <input
                    type="checkbox"
                    checked={entry.isClosed}
                    onChange={(event) => {
                      const next = [...hours];
                      next[index] = { ...entry, isClosed: event.target.checked };
                      setHours(next);
                    }}
                  />
                  Dam olish
                </label>
                {!entry.isClosed ? (
                  <>
                    <input
                      type="time"
                      value={entry.opensAt}
                      onChange={(event) => {
                        const next = [...hours];
                        next[index] = { ...entry, opensAt: event.target.value };
                        setHours(next);
                      }}
                      className="rounded-stall border border-ink/15 bg-white px-2 py-1 font-body text-sm tabular-nums text-ink dark:border-paper/15 dark:bg-paper/5 dark:text-paper"
                    />
                    <input
                      type="time"
                      value={entry.closesAt}
                      onChange={(event) => {
                        const next = [...hours];
                        next[index] = { ...entry, closesAt: event.target.value };
                        setHours(next);
                      }}
                      className="rounded-stall border border-ink/15 bg-white px-2 py-1 font-body text-sm tabular-nums text-ink dark:border-paper/15 dark:bg-paper/5 dark:text-paper"
                    />
                  </>
                ) : null}
              </div>
            ))}
          </div>
        </fieldset>

        {error ? <p role="alert" className="mt-4 font-body text-sm text-pomegranate">{error}</p> : null}
        {done ? <p className="mt-4 font-body text-sm text-tile dark:text-tile-light">Bozor qo'shildi.</p> : null}

        <button
          type="button"
          onClick={() => create.mutate()}
          disabled={!valid || create.isPending}
          className="mt-5 rounded-stall bg-tile px-4 py-2.5 font-display text-sm text-paper hover:bg-tile-deep disabled:opacity-50"
        >
          {create.isPending ? 'Saqlanmoqda…' : "Bozor qo'shish"}
        </button>
      </div>
    </section>
  );
}

function CategorySection() {
  const api = useApi();
  const queryClient = useQueryClient();

  const [parentId, setParentId] = useState('');
  const [nameUz, setNameUz] = useState('');
  const [defaultUnit, setDefaultUnit] = useState('kg');
  const [allowed, setAllowed] = useState('kg, dona');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const tree = useQuery({
    queryKey: ['category-tree'],
    queryFn: () => api.admin.categoryTree().then((response) => response.data),
  });

  const create = useMutation({
    mutationFn: () =>
      api.admin.createCategory({
        parentId: parentId.trim() === '' ? null : parentId.trim(),
        name: { uz: nameUz.trim() },
        defaultUnit: defaultUnit.trim(),
        allowedUnits: allowed
          .split(',')
          .map((unit) => unit.trim())
          .filter(Boolean),
      }),
    onSuccess: () => {
      setNameUz('');
      setError(null);
      setDone(true);
      void queryClient.invalidateQueries({ queryKey: ['category-tree'] });
    },
    onError: (caught) =>
      setError(caught instanceof ApiError ? (caught.detail ?? caught.message) : 'Saqlanmadi.'),
  });

  const units = allowed.split(',').map((unit) => unit.trim()).filter(Boolean);
  const valid = nameUz.trim().length > 1 && units.length > 0 && units.includes(defaultUnit.trim());

  return (
    <section>
      <h2 className="mb-4 font-display text-lg font-medium text-ink dark:text-paper">
        Kategoriyalar
      </h2>

      {tree.isPending ? (
        <p className="font-body text-sm text-ink/50 dark:text-paper/50">Yuklanmoqda…</p>
      ) : tree.isError || !tree.data ? (
        <p role="alert" className="font-body text-sm text-pomegranate">Daraxtni ochib bo'lmadi.</p>
      ) : (
        <ul className="mb-8 space-y-1">
          {tree.data.map((node) => (
            <CategoryBranch key={node.id} node={node} depth={0} />
          ))}
        </ul>
      )}

      <div className="rounded-stall border border-ink/10 p-5 dark:border-paper/10">
        <h3 className="mb-4 font-display text-base font-medium text-ink dark:text-paper">
          Yangi kategoriya
        </h3>

        <div className="grid gap-4 sm:grid-cols-2">
          <Text label="Ota kategoriya ID (bo'sh = ildiz)" value={parentId} onChange={setParentId} mono />
          <Text label="Nomi (o'zbekcha)" value={nameUz} onChange={setNameUz} />
          <Text label="Asosiy o'lchov" value={defaultUnit} onChange={setDefaultUnit} />
          <Text label="Ruxsat etilgan o'lchovlar (vergul bilan)" value={allowed} onChange={setAllowed} />
        </div>

        {/*
          The default must be one of the allowed units. The server enforces it; saying so here
          stops the form being submitted into a rejection the person cannot see the cause of.
        */}
        {!valid && nameUz.trim().length > 1 ? (
          <p className="mt-3 font-body text-xs text-saffron-deep">
            Asosiy o'lchov ruxsat etilganlar ro'yxatida bo'lishi kerak.
          </p>
        ) : null}

        {error ? <p role="alert" className="mt-3 font-body text-sm text-pomegranate">{error}</p> : null}
        {done ? <p className="mt-3 font-body text-sm text-tile dark:text-tile-light">Kategoriya qo'shildi.</p> : null}

        <button
          type="button"
          onClick={() => create.mutate()}
          disabled={!valid || create.isPending}
          className="mt-5 rounded-stall bg-tile px-4 py-2.5 font-display text-sm text-paper hover:bg-tile-deep disabled:opacity-50"
        >
          {create.isPending ? 'Saqlanmoqda…' : "Kategoriya qo'shish"}
        </button>
      </div>
    </section>
  );
}

function CategoryBranch({ node, depth }: { node: CategoryNode; depth: number }) {
  return (
    <li>
      <div
        className="flex items-baseline gap-2 py-1 font-body text-sm"
        style={{ paddingLeft: `${depth * 1.25}rem` }}
      >
        <span className="text-ink dark:text-paper">{localized(node.name, Locale.UZ_LATN)}</span>
        <span className="font-body text-xs tabular-nums text-ink/40 dark:text-paper/40">{node.id}</span>
      </div>
      {node.children?.length ? (
        <ul>
          {node.children.map((child) => (
            <CategoryBranch key={child.id} node={child} depth={depth + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function Text({
  label,
  value,
  onChange,
  mono,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  mono?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block font-body text-xs text-ink/60 dark:text-paper/60">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={
          mono
            ? 'w-full rounded-stall border border-ink/15 bg-white px-3 py-2.5 font-body text-sm tabular-nums text-ink dark:border-paper/15 dark:bg-paper/5 dark:text-paper'
            : 'w-full rounded-stall border border-ink/15 bg-white px-3 py-2.5 font-body text-sm text-ink dark:border-paper/15 dark:bg-paper/5 dark:text-paper'
        }
      />
    </label>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-3xl px-5 pb-24 pt-8 sm:px-8">
      <h1 className="mb-2 font-display text-2xl font-bold text-ink dark:text-paper">Ma'lumotnoma</h1>
      <p className="mb-8 max-w-lg font-body text-sm text-ink/55 dark:text-paper/55">
        Bozorlar va kategoriyalar kamdan-kam o'zgaradi, lekin bu yerdagi xato hamma joyda
        ko'rinadi.
      </p>
      {children}
    </main>
  );
}
