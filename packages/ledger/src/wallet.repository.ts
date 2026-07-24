import { Types, type ClientSession } from 'mongoose';
import type { WalletState } from '@bozorlar/domain';
import { WalletModel, type WalletDoc } from './models/wallet.model.js';
import { ledgerRepository, type WalletRecord } from './ledger.repository.js';

export const walletRepository = {
  /**
   * Returns the seller's wallet, creating it if this is their first charge.
   *
   * Upsert rather than create-on-approval: a wallet is a consequence of trading, and making
   * every path that might charge depend on an earlier one having run is how a seller ends up
   * with an order that cannot be billed.
   */
  async ensureFor(ownerId: string, session?: ClientSession): Promise<WalletRecord> {
    const doc = await WalletModel.findOneAndUpdate(
      { ownerId: new Types.ObjectId(ownerId) },
      { $setOnInsert: { ownerId: new Types.ObjectId(ownerId), ownerType: 'SELLER', schemaVersion: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true, ...(session ? { session } : {}) },
    ).lean<WalletDoc>();
    return ledgerRepository.toWalletRecord(doc);
  },

  async findByOwner(ownerId: string): Promise<WalletRecord | null> {
    if (!Types.ObjectId.isValid(ownerId)) return null;
    const doc = await WalletModel.findOne({ ownerId }).lean<WalletDoc>();
    return doc ? ledgerRepository.toWalletRecord(doc) : null;
  },

  async findById(walletId: string): Promise<WalletRecord | null> {
    if (!Types.ObjectId.isValid(walletId)) return null;
    const doc = await WalletModel.findById(walletId).lean<WalletDoc>();
    return doc ? ledgerRepository.toWalletRecord(doc) : null;
  },

  async setState(
    walletId: string,
    state: WalletState,
    belowFloorSince: Date | null,
    session: ClientSession,
  ): Promise<void> {
    await WalletModel.updateOne({ _id: walletId }, { $set: { state, belowFloorSince } }, { session });
  },

  async setThresholds(
    walletId: string,
    input: { lowBalanceThresholdMinor: bigint; deactivateBelowMinor: bigint; graceHours: number },
  ): Promise<WalletRecord | null> {
    const doc = await WalletModel.findByIdAndUpdate(
      walletId,
      { $set: input },
      { new: true, runValidators: true },
    ).lean<WalletDoc>();
    return doc ? ledgerRepository.toWalletRecord(doc) : null;
  },

  /** Wallets whose grace period may have run out. Read by the deactivation sweep. */
  async findGraceExpired(limit: number, now: Date): Promise<WalletRecord[]> {
    const docs = await WalletModel.find({ state: 'LOW', belowFloorSince: { $ne: null } })
      .limit(limit)
      .lean<WalletDoc[]>();
    return docs
      .filter((doc) => doc.belowFloorSince !== null)
      .filter(
        (doc) =>
          (now.getTime() - (doc.belowFloorSince as Date).getTime()) / 3_600_000 >= doc.graceHours,
      )
      .map((doc) => ledgerRepository.toWalletRecord(doc));
  },
};
