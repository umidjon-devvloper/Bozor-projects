'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApiError } from '@bozorlar/api-client';
import { useSession } from '@/lib/session';

/**
 * Signing in, and registering, on one page.
 *
 * They are one form because the difference between them — for somebody who shops at a bazaar
 * and has never used the site — is not a decision worth a separate page. A phone number either
 * belongs to an account or it does not, and the toggle is right there rather than behind a link
 * at the bottom that people miss.
 */
export default function SignInPage() {
  const router = useRouter();
  const { signIn, register } = useSession();
  const [mode, setMode] = useState<'signIn' | 'register'>('signIn');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The promise is discarded explicitly: React's onSubmit expects void, and a floating
  // promise here would swallow a rejection instead of the catch below handling it.
  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'signIn') await signIn(phone, password);
      else await register({ phone, password, name });
      router.push('/');
    } catch (caught) {
      // The server's message is shown as it stands: it is already written for a reader and is
      // more specific than anything this form could infer from a status code.
      setError(
        caught instanceof ApiError
          ? (caught.detail ?? caught.message)
          : 'Ulanmadi. Internetni tekshirib, qayta urinib ko\u2019ring.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-sm px-5 pb-24 pt-16 sm:px-8">
      <h1 className="font-display text-2xl font-bold text-ink dark:text-paper">
        {mode === 'signIn' ? 'Kirish' : "Ro\u2019yxatdan o\u2019tish"}
      </h1>
      <p className="mt-2 font-body text-sm text-ink/60 dark:text-paper/60">
        {mode === 'signIn'
          ? "Buyurtma berish uchun telefon raqamingiz bilan kiring."
          : "Telefon raqamingiz buyurtmani do\u2019kon bilan bog\u2019lash uchun kerak."}
      </p>

      <form onSubmit={(event) => void submit(event)} className="mt-8 space-y-4">
        {mode === 'register' ? (
          <Field label="Ismingiz" value={name} onChange={setName} autoComplete="name" required />
        ) : null}
        <Field
          label="Telefon"
          value={phone}
          onChange={setPhone}
          type="tel"
          autoComplete="tel"
          placeholder="+998 90 123 45 67"
          required
        />
        <Field
          label="Parol"
          value={password}
          onChange={setPassword}
          type="password"
          autoComplete={mode === 'signIn' ? 'current-password' : 'new-password'}
          required
        />

        {error ? (
          <p role="alert" className="rounded-stall bg-pomegranate/10 px-3 py-2 font-body text-sm text-pomegranate">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-stall bg-tile px-4 py-3 font-display text-sm font-medium text-paper transition-colors hover:bg-tile-deep disabled:opacity-60"
        >
          {busy ? 'Kutib turing…' : mode === 'signIn' ? 'Kirish' : "Ro\u2019yxatdan o\u2019tish"}
        </button>
      </form>

      <button
        type="button"
        onClick={() => {
          setMode(mode === 'signIn' ? 'register' : 'signIn');
          setError(null);
        }}
        className="mt-6 font-body text-sm text-tile underline-offset-4 hover:underline dark:text-tile-light"
      >
        {mode === 'signIn' ? "Hisobim yo\u2019q — ro\u2019yxatdan o\u2019taman" : 'Hisobim bor — kiraman'}
      </button>
    </main>
  );
}

function Field({
  label,
  value,
  onChange,
  ...rest
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return (
    <label className="block">
      <span className="mb-1.5 block font-body text-xs text-ink/60 dark:text-paper/60">{label}</span>
      <input
        {...rest}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-stall border border-ink/15 bg-white px-3 py-2.5 font-body text-sm text-ink placeholder:text-ink/30 dark:border-paper/15 dark:bg-paper/5 dark:text-paper"
      />
    </label>
  );
}
