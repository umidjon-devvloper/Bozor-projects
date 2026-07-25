import { formatSom } from '@bozorlar/api-client';
import { clsx } from 'clsx';

/**
 * The price board.
 *
 * At a bazaar the price is chalked onto a slate propped against the produce, wiped and
 * rewritten when it moves — sometimes twice in a morning. It is the one object every shopper
 * reads first and the only thing on the stall that changes daily, so it is the thing this
 * interface is built around rather than a card, a badge or a gradient.
 *
 * When a price falls, the old figure stays struck through instead of disappearing. That is not
 * decoration: the backend already tracks the price each shopper was last shown (ADR-0034), so
 * the interface can show the same comparison the alert did, and a drop somebody was notified
 * about is legible on the page they land on.
 */
export function PriceBoard({
  minor,
  previousMinor,
  unit,
  size = 'md',
  className,
}: {
  minor: string;
  previousMinor?: string | null;
  unit: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string | undefined;
}) {
  const dropped = previousMinor != null && BigInt(previousMinor) > BigInt(minor);

  return (
    <div
      className={clsx(
        'inline-flex flex-col items-start rounded-stall bg-slate-board px-3 py-2 shadow-board',
        'border border-slate-edge',
        className,
      )}
    >
      {dropped ? (
        <span className="font-body text-[0.6875rem] leading-none text-chalk-dim line-through decoration-saffron decoration-2">
          {formatSom(previousMinor)}
        </span>
      ) : null}

      <span className="flex items-baseline gap-1.5">
        <span
          className={clsx(
            'font-display tabular-nums leading-none text-chalk',
            size === 'sm' && 'text-lg',
            size === 'md' && 'text-2xl',
            size === 'lg' && 'text-4xl',
          )}
        >
          {formatSom(minor)}
        </span>
        <span className="font-body text-xs text-chalk-dim">so'm/{unit}</span>
      </span>
    </div>
  );
}

/**
 * The address of a stall, written the way a person gives directions to one.
 *
 * Not a brand name and not a card header: at Chorsu nobody looks for "Nodira Trading", they
 * look for the vegetable row, fourteenth stall. The backend stores exactly that — market,
 * section code, stall number — so the interface uses it as the primary identity and keeps the
 * shop's own name secondary.
 */
export function StallAddress({
  market,
  section,
  stall,
  className,
}: {
  market: string;
  section?: string | null;
  stall?: string | null;
  className?: string | undefined;
}) {
  const parts = [market, section, stall ? `${stall}-do'kon` : null].filter(Boolean);
  return (
    <p className={clsx('font-body text-xs text-ink/60 dark:text-paper/60', className)}>
      {parts.map((part, index) => (
        <span key={part}>
          {index > 0 ? <span className="px-1.5 text-saffron">·</span> : null}
          {part}
        </span>
      ))}
    </p>
  );
}
