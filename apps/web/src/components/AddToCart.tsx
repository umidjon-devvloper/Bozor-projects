'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApiError, formatQuantity } from '@bozorlar/api-client';
import type { ProductResponse } from '@bozorlar/contracts';
import { useApi, useSession } from '@/lib/session';

/**
 * Choosing how much, and adding it.
 *
 * The stepper obeys the product's own rules rather than counting in ones: produce is sold in
 * steps of a quarter or half kilo, with a minimum below which a stall will not weigh anything
 * out. Those numbers are on the product and are enforced at checkout, so a control that let
 * somebody pick 300 grams of something sold in half-kilos would be building a rejection.
 *
 * Quantities are integer thousandths throughout — never a float. `0.1 + 0.2` is not `0.3`, and
 * a basket that disagrees with the server about a weight is a dispute at the stall.
 */
export function AddToCart({ product }: { product: ProductResponse }) {
  const api = useApi();
  const { status } = useSession();
  const router = useRouter();

  const step = BigInt(product.stepQty.value);
  const min = BigInt(product.minOrderQty.value);
  const available = BigInt(product.availableQty.value);
  const unit = product.availableQty.unit;

  const [qty, setQty] = useState<bigint>(min > 0n ? min : step);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);
  const [busy, setBusy] = useState(false);

  const canDecrease = qty - step >= min;
  const canIncrease = qty + step <= available;

  async function add(): Promise<void> {
    if (status !== 'signed-in') {
      router.push('/kirish');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.cart.addItem(product.id, qty.toString());
      setAdded(true);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? (caught.detail ?? caught.message)
          : "Savatga qo\u2019shib bo\u2019lmadi. Qayta urinib ko\u2019ring.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (!product.isPurchasable) return null;

  return (
    <div className="rounded-stall border border-ink/10 bg-white/60 p-4 dark:border-paper/10 dark:bg-paper/5">
      <div className="flex items-center gap-3">
        <div className="flex items-center rounded-stall border border-ink/15 dark:border-paper/15">
          <StepButton
            label={`${formatQuantity(step.toString(), unit)} kamaytirish`}
            disabled={!canDecrease}
            onClick={() => setQty(qty - step)}
          >
            −
          </StepButton>
          <span className="min-w-[6rem] px-3 text-center font-display text-base tabular-nums text-ink dark:text-paper">
            {formatQuantity(qty.toString(), unit)}
          </span>
          <StepButton
            label={`${formatQuantity(step.toString(), unit)} oshirish`}
            disabled={!canIncrease}
            onClick={() => setQty(qty + step)}
          >
            +
          </StepButton>
        </div>

        <button
          type="button"
          onClick={() => void add()}
          disabled={busy}
          className="flex-1 rounded-stall bg-tile px-4 py-3 font-display text-sm font-medium text-paper transition-colors hover:bg-tile-deep disabled:opacity-60"
        >
          {busy ? "Qo\u2019shilmoqda…" : status === 'signed-in' ? "Savatga qo\u2019shish" : 'Kirib qo\u2019shish'}
        </button>
      </div>

      {!canIncrease ? (
        <p className="mt-3 font-body text-xs text-ink/55 dark:text-paper/55">
          Do'konda shuncha qolgan: {formatQuantity(available.toString(), unit)}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 font-body text-sm text-pomegranate">
          {error}
        </p>
      ) : null}

      {added ? (
        <p className="mt-3 font-body text-sm text-tile dark:text-tile-light">
          Savatga qo'shildi.{' '}
          <a href="/savat" className="underline underline-offset-4">
            Savatni ochish
          </a>
        </p>
      ) : null}
    </div>
  );
}

function StepButton({
  children,
  label,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="px-3.5 py-3 font-display text-lg leading-none text-ink transition-colors hover:text-tile disabled:opacity-30 dark:text-paper"
    >
      {children}
    </button>
  );
}
