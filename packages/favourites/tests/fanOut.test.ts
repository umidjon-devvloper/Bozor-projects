import { describe, expect, it, vi } from 'vitest';
import { createFavouriteAlertService, type ProductSnapshot } from '../src/index.js';
import { favouriteRepository } from '../src/repositories/favourite.repository.js';

/**
 * The fan-out's failure behaviour.
 *
 * The decision logic is covered elsewhere; what is tested here is what happens when one
 * recipient's delivery fails, because that is where a fault is expensive and invisible. The
 * repository is stubbed at the module boundary rather than through a port, since the fan-out
 * owns its own data access by design.
 */

const product: ProductSnapshot = {
  productId: 'p1',
  shopId: 's1',
  name: 'Pomidor',
  shopName: 'Rasta 14',
  priceLabel: '9 000',
  priceMinor: 900_000n,
  isVisible: true,
  isPurchasable: true,
};

function followers(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `f${index}`,
    userId: `u${index}`,
    targetType: 'PRODUCT' as const,
    targetId: 'p1',
    shopId: 's1',
    alertsEnabled: true,
    createdAt: new Date(),
    // Was unavailable, so every one of them is owed a restock alert.
    state: {
      priceWatermarkMinor: 900_000n,
      wasPurchasable: false,
      lastPriceAlertAt: null,
      lastRestockAlertAt: null,
    },
  }));
}

describe('fanOutProduct', () => {
  it('keeps going when one recipient fails, and reports the loss', async () => {
    // A dead device token used to throw out of the loop, leaving everybody queued behind it
    // with nothing — and because the failing follower's state had already advanced, a redelivery
    // skipped them and stopped in the same place again.
    const page = vi
      .spyOn(favouriteRepository, 'pageFollowers')
      .mockResolvedValueOnce(followers(3))
      .mockResolvedValue([]);
    vi.spyOn(favouriteRepository, 'advanceState').mockResolvedValue(true);

    const notify = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('device token no longer registered'))
      .mockResolvedValueOnce(undefined);

    const service = createFavouriteAlertService({
      readProduct: async () => product,
      notify,
      log: () => undefined,
    });

    const result = await service.fanOutProduct('p1', 'e1');

    expect(notify).toHaveBeenCalledTimes(3);
    expect(result.considered).toBe(3);
    expect(result.alerted).toBe(2);
    expect(result.failed).toBe(1);
    page.mockRestore();
    vi.restoreAllMocks();
  });

  it('does not notify when the compare-and-set is lost', async () => {
    // Another worker already advanced this favourite, so it has been told.
    vi.spyOn(favouriteRepository, 'pageFollowers')
      .mockResolvedValueOnce(followers(1))
      .mockResolvedValue([]);
    vi.spyOn(favouriteRepository, 'advanceState').mockResolvedValue(false);

    const notify = vi.fn();
    const service = createFavouriteAlertService({
      readProduct: async () => product,
      notify,
      log: () => undefined,
    });

    const result = await service.fanOutProduct('p1', 'e1');

    expect(notify).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    vi.restoreAllMocks();
  });

  it('does nothing at all for a product that no longer exists', async () => {
    const notify = vi.fn();
    const service = createFavouriteAlertService({
      readProduct: async () => null,
      notify,
      log: () => undefined,
    });

    const result = await service.fanOutProduct('gone', 'e1');

    expect(notify).not.toHaveBeenCalled();
    expect(result.considered).toBe(0);
  });
});
