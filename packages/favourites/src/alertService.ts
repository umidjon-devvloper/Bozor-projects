import type { AlertKind } from './constants.js';
import { decideProductAlerts, type ProductAlertInputs } from './alertPolicy.js';
import { favouriteRepository } from './repositories/favourite.repository.js';

/**
 * Turning a product change into notifications for the people following it.
 *
 * The ports below are injected rather than imported because this runs in the worker while the
 * catalogue and the notification engine belong to other deployables (ADR-0011). It is also
 * what makes the fan-out testable without a database or a push provider.
 */

export interface ProductSnapshot extends ProductAlertInputs {
  productId: string;
  shopId: string;
  /** For the notification body. Already localised by the reader. */
  name: string;
  shopName: string;
  /** Major-unit string, formatted for display by the reader. */
  priceLabel: string;
}

export interface FavouriteAlertPorts {
  /**
   * Reads the product as it *is now*, not as the event said it became.
   *
   * The same discipline the search indexer follows: under at-least-once delivery with no
   * ordering guarantee, the event is a hint that something changed and the database is the
   * only thing that can be trusted about what it changed to.
   */
  readProduct(productId: string): Promise<ProductSnapshot | null>;
  notify(input: {
    userId: string;
    kind: AlertKind;
    product: ProductSnapshot;
    dedupeKey: string;
  }): Promise<void>;
  log(message: string, fields: Record<string, unknown>): void;
}

export interface FanOutResult {
  productId: string;
  considered: number;
  alerted: number;
  skipped: number;
  /** Recipients whose delivery threw. Counted rather than thrown so the pass finishes. */
  failed: number;
}

export function createFavouriteAlertService(ports: FavouriteAlertPorts) {
  return {
    /**
     * Alerts everyone following one product.
     *
     * Paged rather than loaded at once: a product favourited by fifty thousand people would
     * otherwise be one unbounded query and one unbounded burst of pushes. Each favourite is
     * decided and advanced independently, so a single failure costs one notification and the
     * retry re-decides only what is still outstanding.
     */
    async fanOutProduct(productId: string, eventId: string): Promise<FanOutResult> {
      const product = await ports.readProduct(productId);
      if (!product) {
        return { productId, considered: 0, alerted: 0, skipped: 0, failed: 0 };
      }

      const now = new Date();
      let cursor: string | null = null;
      let considered = 0;
      let alerted = 0;
      let skipped = 0;
      let failed = 0;

      for (;;) {
        const page = await favouriteRepository.pageFollowers({
          targetId: productId,
          afterId: cursor,
        });
        if (page.length === 0) break;

        for (const favourite of page) {
          considered += 1;
          const decision = decideProductAlerts(favourite.state, product, now);

          if (decision.alerts.length === 0) {
            // Still write the observation back when it moved, so the next pass compares
            // against the truth rather than re-deriving the same non-decision forever.
            const changed =
              decision.nextState.priceWatermarkMinor !== favourite.state.priceWatermarkMinor ||
              decision.nextState.wasPurchasable !== favourite.state.wasPurchasable;
            if (changed) {
              await favouriteRepository.advanceState(
                favourite.id,
                favourite.state,
                decision.nextState,
              );
            }
            continue;
          }

          /**
           * The state moves *before* the notification is sent, and only if the conditional
           * update matches.
           *
           * This ordering is deliberate. Sending first and recording afterwards means a crash
           * between the two sends the alert again on retry; recording first means a crash
           * costs one missed alert. A missed price-drop alert is a disappointment. A repeated
           * one, arriving four times at midnight, is why people disable notifications.
           */
          const won = await favouriteRepository.advanceState(
            favourite.id,
            favourite.state,
            decision.nextState,
          );
          if (!won) {
            skipped += 1;
            continue;
          }

          for (const kind of decision.alerts) {
            /**
             * One recipient's failure must not end the pass.
             *
             * Without this, a single dead device token or a provider timeout throws out of the
             * loop and everybody queued behind it hears nothing — tens of thousands of people
             * on a popular product. It is worse than it first looks: the state has already
             * advanced for the follower that failed, so a redelivery of the event skips them
             * and stops at the same place again. A permanently bad token would block that
             * product's alerts for good.
             *
             * The alert is lost for that one person, which is the trade the ordering above
             * already accepts. It is recorded so the loss is visible rather than silent.
             */
            try {
              await ports.notify({
                userId: favourite.userId,
                kind,
                product,
                // Scoped to the favourite and the kind rather than to the event, so two
                // different events that both warrant a restock alert still deduplicate.
                dedupeKey: `favourite:${favourite.id}:${kind}:${now.toISOString().slice(0, 10)}`,
              });
              alerted += 1;
            } catch (error) {
              failed += 1;
              ports.log('favourite alert delivery failed', {
                productId,
                favouriteId: favourite.id,
                kind,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }

        const last = page[page.length - 1];
        if (!last) break;
        cursor = last.id;
      }

      ports.log('favourite alert fan-out complete', {
        productId,
        eventId,
        considered,
        alerted,
        skipped,
        failed,
      });
      return { productId, considered, alerted, skipped, failed };
    },

    /**
     * A shop coming back into view re-evaluates every followed product it sells.
     *
     * This is the seller-availability path: while a seller is deactivated their products are
     * invisible and every favourite goes quiet with `wasPurchasable: false`. When they top up
     * and the shop returns, the restock edge fires naturally for anyone whose product is back
     * in stock — no separate "seller is back" notification, because what the buyer actually
     * cares about is the tomatoes, not the wallet.
     */
    async fanOutShop(shopId: string, eventId: string): Promise<FanOutResult[]> {
      const productIds = await favouriteRepository.productIdsFollowedInShop(shopId);
      const results: FanOutResult[] = [];
      for (const productId of productIds) {
        // Same reasoning as the per-recipient catch: one product that cannot be read must not
        // end a pass covering every followed product in a returning seller's stall.
        try {
          results.push(await this.fanOutProduct(productId, eventId));
        } catch (error) {
          ports.log('favourite alert fan-out failed for product', {
            shopId,
            productId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      ports.log('favourite alert fan-out for shop complete', {
        shopId,
        eventId,
        products: productIds.length,
      });
      return results;
    },
  };
}

export type FavouriteAlertService = ReturnType<typeof createFavouriteAlertService>;
