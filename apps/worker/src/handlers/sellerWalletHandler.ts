import mongoose from 'mongoose';
import type { Logger } from '@bozorlar/logger';
import type { DomainEventEnvelope } from '../eventDispatcher.js';
import { text } from '../payload.js';

/**
 * Carries a wallet's activation state onto the seller's shops.
 *
 * `shops.sellerWalletActive` has been read by the visibility rule since the geo module was
 * built and written by nothing until now. This handler closes that loop: a seller whose
 * balance runs out disappears from the catalogue, which is the commercial mechanism the whole
 * prepaid model depends on (WALLET_SYSTEM.md).
 *
 * It does not decide visibility itself — it sets the input and lets the shop's own rule run,
 * so a suspended or unmoderated shop is not accidentally published by a top-up.
 */
export function createSellerWalletHandler(logger: Logger) {
  return async function handle(event: DomainEventEnvelope): Promise<void> {
    const db = mongoose.connection.db;
    if (!db) throw new Error('No database connection');

    const sellerId = text(event.payload.sellerId);
    if (!sellerId) return;
    const active = event.type === 'seller.reactivated';
    const now = new Date();

    const shops = db.collection('shops');
    await shops.updateMany(
      { ownerId: new mongoose.Types.ObjectId(sellerId), deletedAt: null },
      { $set: { sellerWalletActive: active } },
    );

    if (!active) {
      const hidden = await shops.updateMany(
        { ownerId: new mongoose.Types.ObjectId(sellerId), deletedAt: null },
        {
          $set: {
            isVisible: false,
            visibilityReason: 'SELLER_WALLET_INACTIVE',
            visibilityComputedAt: now,
          },
        },
      );
      logger.warn({ sellerId, shops: hidden.modifiedCount }, 'seller hidden: wallet inactive');
      return;
    }

    // Reactivation restores only shops that would otherwise be visible on their own merits.
    const restored = await shops.updateMany(
      {
        ownerId: new mongoose.Types.ObjectId(sellerId),
        deletedAt: null,
        status: 'ACTIVE',
        moderationStatus: 'APPROVED',
        $or: [{ vacationUntil: null }, { vacationUntil: { $lte: now } }],
      },
      { $set: { isVisible: true, visibilityReason: 'VISIBLE', visibilityComputedAt: now } },
    );
    logger.info({ sellerId, shops: restored.modifiedCount }, 'seller restored: wallet funded');
  };
}
