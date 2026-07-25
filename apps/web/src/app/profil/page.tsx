'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ApiError } from '@bozorlar/api-client';
import { useApi, useSession } from '@/lib/session';

/**
 * The account.
 *
 * Deliberately small. The only things a buyer can change here are their name and the language
 * notifications arrive in — the phone number is the account's identity and changing it is a
 * different, verified flow, not a text field.
 */
export default function ProfilePage() {
  const api = useApi();
  const { status, user, signOut } = useSession();
  const [firstName, setFirstName] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (status === 'signed-out') {
    return (
      <Shell>
        <Link href="/kirish" className="font-body text-sm text-tile hover:underline">
          Kirish
        </Link>
      </Shell>
    );
  }

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api.profile.update({ firstName: firstName.trim() });
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? (caught.detail ?? caught.message) : 'Saqlanmadi.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <dl className="mb-8 space-y-3 font-body text-sm">
        <div>
          <dt className="text-xs text-ink/45 dark:text-paper/45">Telefon</dt>
          <dd className="mt-0.5 tabular-nums text-ink dark:text-paper">{user?.phone ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink/45 dark:text-paper/45">Ism</dt>
          <dd className="mt-0.5 text-ink dark:text-paper">{user?.name ?? '—'}</dd>
        </div>
      </dl>

      <label className="block">
        <span className="mb-1.5 block font-body text-xs text-ink/60 dark:text-paper/60">
          Ismni o'zgartirish
        </span>
        <input
          value={firstName}
          onChange={(event) => setFirstName(event.target.value)}
          placeholder={user?.name ?? ''}
          className="w-full rounded-stall border border-ink/15 bg-white px-3 py-2.5 font-body text-sm text-ink placeholder:text-ink/30 dark:border-paper/15 dark:bg-paper/5 dark:text-paper"
        />
      </label>

      {error ? (
        <p role="alert" className="mt-3 font-body text-sm text-pomegranate">{error}</p>
      ) : null}
      {saved ? (
        <p className="mt-3 font-body text-sm text-tile dark:text-tile-light">Saqlandi.</p>
      ) : null}

      <button
        type="button"
        onClick={() => void save()}
        disabled={busy || firstName.trim().length === 0}
        className="mt-4 rounded-stall bg-tile px-4 py-2.5 font-display text-sm text-paper hover:bg-tile-deep disabled:opacity-50"
      >
        {busy ? 'Saqlanmoqda…' : 'Saqlash'}
      </button>

      <div className="mt-12 border-t border-ink/10 pt-6 dark:border-paper/10">
        <div className="flex flex-wrap gap-4 font-body text-sm">
          <Link href="/sevimlilar" className="text-tile hover:underline dark:text-tile-light">
            Kuzatilayotganlar
          </Link>
          <Link href="/buyurtmalarim" className="text-tile hover:underline dark:text-tile-light">
            Buyurtmalarim
          </Link>
        </div>
        <button
          type="button"
          onClick={() => void signOut()}
          className="mt-6 font-body text-sm text-pomegranate underline-offset-4 hover:underline"
        >
          Hisobdan chiqish
        </button>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-md px-5 pb-24 pt-10 sm:px-8">
      <h1 className="mb-8 font-display text-3xl font-bold text-ink dark:text-paper">Profil</h1>
      {children}
    </main>
  );
}
