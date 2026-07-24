import { AlertKind, PRICE_ALERT_COOLDOWN_HOURS, PRICE_DROP_MIN_BP, PRICE_DROP_MIN_MINOR, RESTOCK_ALERT_COOLDOWN_HOURS } from './constants.js';

/**
 * When a favourite is worth interrupting somebody about.
 *
 * Pure: no database, no clock, no notifier. The whole point of alerting is that it is easy to
 * get subtly wrong in ways nobody notices until users are annoyed, so the decision lives in a
 * function that can be exhaustively tested and the fan-out does nothing but obey it.
 *
 * The decision is taken against **the favourite's own stored watermark**, never against the
 * event that triggered the pass. Events are delivered at least once and may arrive out of
 * order (ADR-0012); a price-drop alert derived from `payload.from` and `payload.to` would fire
 * twice on a redelivery and would fire wrongly if two edits arrived reversed. A watermark
 * stored per favourite is order-independent and idempotent: the second pass finds the
 * watermark already moved and decides nothing.
 */

export interface FavouriteAlertState {
  /**
   * The price this user has already been shown, in tiyin.
   *
   * Set when the product is favourited and moved every time an alert is sent — and also moved
   * upward when the price rises, so the reference is the *current regular price* rather than
   * whatever the price happened to be on the day of favouriting. Without that, one seasonal
   * fall would exhaust the alert forever: a tomato favourited at 12 000 and now regularly
   * 30 000 would never again produce a drop.
   */
  priceWatermarkMinor: bigint | null;
  /** What the last pass observed. The restock alert is the false-to-true edge of this. */
  wasPurchasable: boolean;
  lastPriceAlertAt: Date | null;
  lastRestockAlertAt: Date | null;
}

export interface ProductAlertInputs {
  /** Current price in tiyin, read from the database rather than from the event. */
  priceMinor: bigint;
  /** Visible in the catalogue: live status, moderation approved, shop visible. */
  isVisible: boolean;
  /** Visible *and* enough stock remains to satisfy the product's own minimum order. */
  isPurchasable: boolean;
}

export interface AlertDecision {
  alerts: readonly AlertKind[];
  /** The state to write back. Written with a conditional update, which is the real guard. */
  nextState: FavouriteAlertState;
}

function hoursSince(from: Date | null, now: Date): number {
  if (!from) return Number.POSITIVE_INFINITY;
  return (now.getTime() - from.getTime()) / 3_600_000;
}

/** A drop counts when it clears both the proportional and the absolute floor. */
export function isMeaningfulDrop(watermarkMinor: bigint, priceMinor: bigint): boolean {
  if (priceMinor >= watermarkMinor) return false;
  const delta = watermarkMinor - priceMinor;
  if (delta < PRICE_DROP_MIN_MINOR) return false;
  return delta * 10_000n >= watermarkMinor * BigInt(PRICE_DROP_MIN_BP);
}

export function decideProductAlerts(
  state: FavouriteAlertState,
  product: ProductAlertInputs,
  now: Date,
): AlertDecision {
  const alerts: AlertKind[] = [];

  /**
   * A product nobody can see is a product nobody can act on.
   *
   * This is where seller availability enters: a deactivated seller's shop is not visible, the
   * worker has already materialised that onto the product, and every favourite of it goes
   * quiet. Alerting somebody about a stall they cannot buy from is worse than silence — it
   * sends them to the bazaar for nothing.
   *
   * The state is still advanced, so that when the seller tops up and the shop returns, the
   * favourite resumes from what is true then rather than replaying a backlog.
   */
  if (!product.isVisible) {
    return {
      alerts,
      nextState: {
        priceWatermarkMinor: state.priceWatermarkMinor,
        wasPurchasable: false,
        lastPriceAlertAt: state.lastPriceAlertAt,
        lastRestockAlertAt: state.lastRestockAlertAt,
      },
    };
  }

  let watermark = state.priceWatermarkMinor ?? product.priceMinor;
  let lastPriceAlertAt = state.lastPriceAlertAt;
  let lastRestockAlertAt = state.lastRestockAlertAt;

  if (
    isMeaningfulDrop(watermark, product.priceMinor) &&
    hoursSince(state.lastPriceAlertAt, now) >= PRICE_ALERT_COOLDOWN_HOURS
  ) {
    alerts.push(AlertKind.PRICE_DROP);
    lastPriceAlertAt = now;
    watermark = product.priceMinor;
  } else if (product.priceMinor > watermark) {
    // The price rose. Follow it, so the next genuine fall is measured from the new normal.
    watermark = product.priceMinor;
  } else if (isMeaningfulDrop(watermark, product.priceMinor)) {
    // A real drop, suppressed only by the cooldown. The watermark still follows the price:
    // holding the old reference would make the *next* pass alert about the same fall.
    watermark = product.priceMinor;
  }

  if (
    product.isPurchasable &&
    !state.wasPurchasable &&
    hoursSince(state.lastRestockAlertAt, now) >= RESTOCK_ALERT_COOLDOWN_HOURS
  ) {
    alerts.push(AlertKind.RESTOCK);
    lastRestockAlertAt = now;
  }

  return {
    alerts,
    nextState: {
      priceWatermarkMinor: watermark,
      wasPurchasable: product.isPurchasable,
      lastPriceAlertAt,
      lastRestockAlertAt,
    },
  };
}
