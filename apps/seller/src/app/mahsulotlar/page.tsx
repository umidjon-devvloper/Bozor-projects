'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, formatSom } from '@bozorlar/api-client';
import type { ProductResponse } from '@bozorlar/contracts';
import { useApi, useSession } from '@bozorlar/session';

/**
 * Price and stock, edited in place.
 *
 * This is the most repeated action on the platform: a stall re-chalks its prices every morning
 * and adjusts stock through the day. So there is no detail page to open and no form to submit —
 * each row edits itself, one field at a time, and saves on blur.
 *
 * Prices are entered in som because that is what a seller writes on the board, and converted to
 * tiyin here. The conversion refuses a third decimal rather than rounding it: a price the seller
 * did not type is a price they will be held to.
 */
export default function ProductsPage() {
  const api = useApi();
  const { status } = useSession();

  const products = useQuery({
    queryKey: ['seller-products'],
    queryFn: () => api.seller.products.list({ limit: 200 }).then((response) => response.data),
    enabled: status === 'signed-in',
  });

  if (status === 'loading' || products.isPending) {
    return <Shell><p className="font-body text-sm text-ink/50 dark:text-paper/50">Yuklanmoqda…</p></Shell>;
  }
  if (status === 'signed-out') {
    return <Shell><a href="/kirish" className="font-body text-sm text-saffron-deep hover:underline">Kirish</a></Shell>;
  }
  if (products.isError) {
    return <Shell><p role="alert" className="font-body text-sm text-pomegranate">Mahsulotlarni ochib bo'lmadi.</p></Shell>;
  }
  if (products.data.length === 0) {
    return (
      <Shell>
        <p className="font-body text-sm text-ink/70 dark:text-paper/70">Hali mahsulot qo'shilmagan.</p>
      </Shell>
    );
  }

  return (
    <Shell>
      <ul className="space-y-3">
        {products.data.map((product) => (
          <li key={product.id}>
            <ProductRow product={product} />
          </li>
        ))}
      </ul>
    </Shell>
  );
}

/** Som with up to two decimals, to exact tiyin. Refuses rather than rounds. */
function somToMinor(input: string): bigint | null {
  const text = input.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole ?? '0') * 100n + BigInt(fraction.padEnd(2, '0'));
}

function ProductRow({ product }: { product: ProductResponse }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const unit = product.availableQty.unit;

  const [price, setPrice] = useState(() => (BigInt(product.price.amount) / 100n).toString());
  const [stock, setStock] = useState(() => (BigInt(product.availableQty.value) / 1000n).toString());
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<'price' | 'stock' | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['seller-products'] });

  const savePrice = useMutation({
    mutationFn: (minor: string) => api.seller.setPrice(product.id, minor),
    onSuccess: () => {
      setSaved('price');
      setError(null);
      void refresh();
    },
    onError: (caught) =>
      setError(caught instanceof ApiError ? (caught.detail ?? caught.message) : 'Saqlanmadi.'),
  });

  const saveStock = useMutation({
    mutationFn: (milli: string) => api.seller.setStock(product.id, milli),
    onSuccess: () => {
      setSaved('stock');
      setError(null);
      void refresh();
    },
    onError: (caught) =>
      setError(caught instanceof ApiError ? (caught.detail ?? caught.message) : 'Saqlanmadi.'),
  });

  function commitPrice(): void {
    const minor = somToMinor(price);
    if (minor === null) {
      setError("Narxni raqam bilan yozing, masalan 12500 yoki 12500,50");
      return;
    }
    if (minor.toString() === product.price.amount) return;
    savePrice.mutate(minor.toString());
  }

  function commitStock(): void {
    const value = stock.trim().replace(',', '.');
    if (!/^\d+(\.\d{1,3})?$/.test(value)) {
      setError('Qoldiqni raqam bilan yozing');
      return;
    }
    const [whole, fraction = ''] = value.split('.');
    const milli = (BigInt(whole ?? '0') * 1000n + BigInt(fraction.padEnd(3, '0'))).toString();
    if (milli === product.availableQty.value) return;
    saveStock.mutate(milli);
  }

  return (
    <div className="rounded-stall border border-ink/10 bg-white/60 p-4 dark:border-paper/10 dark:bg-paper/5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-display text-base font-medium text-ink dark:text-paper">
            {typeof product.name === 'string' ? product.name : ''}
          </h2>
          <p className="mt-0.5 font-body text-xs text-ink/50 dark:text-paper/50">
            {product.isPurchasable ? 'Sotuvda' : 'Sotuvda emas'}
            {' · '}
            {formatSom(product.price.amount)} so'm/{unit}
          </p>
        </div>

        <Field
          label={`Narx (so'm/${unit})`}
          value={price}
          onChange={setPrice}
          onCommit={commitPrice}
          busy={savePrice.isPending}
          ok={saved === 'price'}
        />
        <Field
          label={`Qoldiq (${unit})`}
          value={stock}
          onChange={setStock}
          onCommit={commitStock}
          busy={saveStock.isPending}
          ok={saved === 'stock'}
        />
      </div>

      {error ? (
        <p role="alert" className="mt-3 font-body text-xs text-pomegranate">{error}</p>
      ) : null}
    </div>
  );
}

/**
 * Saves on blur rather than behind a button.
 *
 * A seller updating twenty prices should not press save twenty times, and the confirmation is
 * a mark beside the field rather than a toast: the point is to see at a glance which rows have
 * gone through while working down the list.
 */
function Field({
  label,
  value,
  onChange,
  onCommit,
  busy,
  ok,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  busy: boolean;
  ok: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block font-body text-[0.6875rem] text-ink/50 dark:text-paper/50">
        {label}
      </span>
      <span className="flex items-center gap-1.5">
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onCommit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
          inputMode="decimal"
          className="w-28 rounded-stall border border-ink/15 bg-white px-2.5 py-2 text-right font-display text-sm tabular-nums text-ink dark:border-paper/15 dark:bg-paper/5 dark:text-paper"
        />
        <span aria-hidden className="w-3 text-sm text-tile">
          {busy ? '…' : ok ? '✓' : ''}
        </span>
      </span>
    </label>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-4xl px-5 pb-24 pt-8 sm:px-8">
      <h1 className="mb-2 font-display text-2xl font-bold text-ink dark:text-paper">Mahsulotlar</h1>
      <p className="mb-8 font-body text-sm text-ink/55 dark:text-paper/55">
        Narx va qoldiqni shu yerda o'zgartirasiz — maydondan chiqsangiz saqlanadi.
      </p>
      {children}
    </main>
  );
}
