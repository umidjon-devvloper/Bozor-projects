import { describe, expect, it } from 'vitest';
import {
  AlertKind,
  PRICE_ALERT_COOLDOWN_HOURS,
  PRICE_DROP_MIN_MINOR,
  decideProductAlerts,
  isMeaningfulDrop,
  type FavouriteAlertState,
  type ProductAlertInputs,
} from '@bozorlar/favourites';

/**
 * The alert decision, which is the whole module.
 *
 * Everything else in favourites is storage and plumbing; this function decides whether a
 * person's phone lights up. It is tested against the two failure modes that matter and are
 * opposites: alerting about something not worth an interruption, and staying silent about
 * something that was.
 */

const NOW = new Date('2026-08-02T10:00:00.000Z');
const hoursAgo = (hours: number): Date => new Date(NOW.getTime() - hours * 3_600_000);

function state(overrides: Partial<FavouriteAlertState> = {}): FavouriteAlertState {
  return {
    priceWatermarkMinor: 1_000_000n, // 10 000 som
    wasPurchasable: true,
    lastPriceAlertAt: null,
    lastRestockAlertAt: null,
    ...overrides,
  };
}

function product(overrides: Partial<ProductAlertInputs> = {}): ProductAlertInputs {
  return { priceMinor: 1_000_000n, isVisible: true, isPurchasable: true, ...overrides };
}

describe('isMeaningfulDrop', () => {
  it('ignores a rise', () => {
    expect(isMeaningfulDrop(1_000_000n, 1_200_000n)).toBe(false);
  });

  it('ignores no change', () => {
    expect(isMeaningfulDrop(1_000_000n, 1_000_000n)).toBe(false);
  });

  it('ignores a fall below the proportional floor', () => {
    // 2% off 10 000 som: real, but not worth a notification.
    expect(isMeaningfulDrop(1_000_000n, 980_000n)).toBe(false);
  });

  it('accepts a fall that clears both floors', () => {
    // 10% off 10 000 som is 1 000 som — over the absolute floor too.
    expect(isMeaningfulDrop(1_000_000n, 900_000n)).toBe(true);
  });

  it('ignores a large percentage of a small price', () => {
    // Half off a 1 000 som bunch of herbs is 500 som: proportionally huge, absolutely trivial.
    const watermark = 100_000n;
    const halved = 50_000n;
    expect(watermark - halved).toBeLessThan(PRICE_DROP_MIN_MINOR);
    expect(isMeaningfulDrop(watermark, halved)).toBe(false);
  });

  it('accepts exactly the threshold', () => {
    // 5% of 40 000 som is 2 000 som, clearing the absolute floor as well.
    expect(isMeaningfulDrop(4_000_000n, 3_800_000n)).toBe(true);
  });
});

describe('decideProductAlerts — price drops', () => {
  it('alerts on a meaningful drop and moves the watermark to the new price', () => {
    const decision = decideProductAlerts(state(), product({ priceMinor: 900_000n }), NOW);
    expect(decision.alerts).toEqual([AlertKind.PRICE_DROP]);
    expect(decision.nextState.priceWatermarkMinor).toBe(900_000n);
    expect(decision.nextState.lastPriceAlertAt).toEqual(NOW);
  });

  it('does not alert twice for the same drop', () => {
    const first = decideProductAlerts(state(), product({ priceMinor: 900_000n }), NOW);
    const second = decideProductAlerts(first.nextState, product({ priceMinor: 900_000n }), NOW);
    expect(second.alerts).toEqual([]);
  });

  it('is silent within the cooldown even for a further fall', () => {
    const recent = state({ lastPriceAlertAt: hoursAgo(1) });
    const decision = decideProductAlerts(recent, product({ priceMinor: 800_000n }), NOW);
    expect(decision.alerts).toEqual([]);
  });

  it('still advances the watermark when the cooldown suppresses the alert', () => {
    // Otherwise the next pass, after the cooldown, would announce a fall that already happened
    // and that the buyer could have seen on the product page hours earlier.
    const recent = state({ lastPriceAlertAt: hoursAgo(1) });
    const decision = decideProductAlerts(recent, product({ priceMinor: 800_000n }), NOW);
    expect(decision.nextState.priceWatermarkMinor).toBe(800_000n);
  });

  it('alerts again once the cooldown has passed', () => {
    const older = state({
      lastPriceAlertAt: hoursAgo(PRICE_ALERT_COOLDOWN_HOURS + 1),
      priceWatermarkMinor: 1_000_000n,
    });
    const decision = decideProductAlerts(older, product({ priceMinor: 900_000n }), NOW);
    expect(decision.alerts).toEqual([AlertKind.PRICE_DROP]);
  });

  it('follows the price upward so the next fall is measured from the new normal', () => {
    // A tomato favourited at 10 000 and now regularly 30 000 must still be able to alert.
    const risen = decideProductAlerts(state(), product({ priceMinor: 3_000_000n }), NOW);
    expect(risen.alerts).toEqual([]);
    expect(risen.nextState.priceWatermarkMinor).toBe(3_000_000n);

    const fallen = decideProductAlerts(risen.nextState, product({ priceMinor: 2_500_000n }), NOW);
    expect(fallen.alerts).toEqual([AlertKind.PRICE_DROP]);
  });

  it('seeds the watermark from the current price when it has none', () => {
    const fresh = state({ priceWatermarkMinor: null });
    const decision = decideProductAlerts(fresh, product({ priceMinor: 750_000n }), NOW);
    expect(decision.alerts).toEqual([]);
    expect(decision.nextState.priceWatermarkMinor).toBe(750_000n);
  });
});

describe('decideProductAlerts — restocks', () => {
  it('alerts on the unavailable-to-available edge', () => {
    const wasOut = state({ wasPurchasable: false });
    const decision = decideProductAlerts(wasOut, product({ isPurchasable: true }), NOW);
    expect(decision.alerts).toEqual([AlertKind.RESTOCK]);
    expect(decision.nextState.wasPurchasable).toBe(true);
  });

  it('does not alert when it was already available', () => {
    const decision = decideProductAlerts(state(), product({ isPurchasable: true }), NOW);
    expect(decision.alerts).toEqual([]);
  });

  it('does not alert when it goes out of stock', () => {
    const decision = decideProductAlerts(state(), product({ isPurchasable: false }), NOW);
    expect(decision.alerts).toEqual([]);
    expect(decision.nextState.wasPurchasable).toBe(false);
  });

  it('does not alert twice for one restock', () => {
    const wasOut = state({ wasPurchasable: false });
    const first = decideProductAlerts(wasOut, product(), NOW);
    const second = decideProductAlerts(first.nextState, product(), NOW);
    expect(second.alerts).toEqual([]);
  });

  it('suppresses a flapping restock inside the cooldown', () => {
    // Stock that flickers as checkout reservations expire and re-open must not translate into
    // a stream of notifications.
    const flapping = state({ wasPurchasable: false, lastRestockAlertAt: hoursAgo(2) });
    const decision = decideProductAlerts(flapping, product(), NOW);
    expect(decision.alerts).toEqual([]);
    expect(decision.nextState.wasPurchasable).toBe(true);
  });
});

describe('decideProductAlerts — seller availability', () => {
  it('says nothing about a product nobody can see', () => {
    const wasOut = state({ wasPurchasable: false });
    const hidden = product({ isVisible: false, isPurchasable: false, priceMinor: 500_000n });
    const decision = decideProductAlerts(wasOut, hidden, NOW);
    expect(decision.alerts).toEqual([]);
  });

  it('does not announce a price drop on a deactivated seller’s stall', () => {
    // The price genuinely fell, but the shop is hidden because the wallet ran out. Sending the
    // buyer to a stall they cannot buy from is worse than silence.
    const decision = decideProductAlerts(
      state(),
      product({ isVisible: false, isPurchasable: false, priceMinor: 500_000n }),
      NOW,
    );
    expect(decision.alerts).toEqual([]);
  });

  it('holds the watermark while hidden so nothing is replayed on return', () => {
    const decision = decideProductAlerts(
      state(),
      product({ isVisible: false, isPurchasable: false, priceMinor: 500_000n }),
      NOW,
    );
    expect(decision.nextState.priceWatermarkMinor).toBe(1_000_000n);
    expect(decision.nextState.wasPurchasable).toBe(false);
  });

  it('fires a restock when the seller tops up and the stall returns', () => {
    const hidden = decideProductAlerts(
      state(),
      product({ isVisible: false, isPurchasable: false }),
      NOW,
    );
    const returned = decideProductAlerts(hidden.nextState, product(), NOW);
    expect(returned.alerts).toEqual([AlertKind.RESTOCK]);
  });
});

describe('decideProductAlerts — both at once', () => {
  it('reports a restock and a price drop together', () => {
    const wasOut = state({ wasPurchasable: false });
    const decision = decideProductAlerts(wasOut, product({ priceMinor: 900_000n }), NOW);
    expect(decision.alerts).toContain(AlertKind.RESTOCK);
    expect(decision.alerts).toContain(AlertKind.PRICE_DROP);
    expect(decision.alerts).toHaveLength(2);
  });

  it('is a pure function of its inputs', () => {
    const input = state({ wasPurchasable: false });
    const snapshot = { ...input };
    decideProductAlerts(input, product({ priceMinor: 900_000n }), NOW);
    expect(input).toEqual(snapshot);
  });
});
