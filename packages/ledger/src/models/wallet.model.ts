import { Schema, model, type Model, type Types } from 'mongoose';
import { WalletState } from '@bozorlar/domain';

/**
 * A seller's prepaid balance.
 *
 * The balance here is materialised, not authoritative: the ledger is the truth, and this is a
 * cache updated in the same transaction as the entry that moved it. `reconcile` recomputes it
 * from the journal, and any divergence is a bug worth an alert rather than a silent repair.
 */
export interface WalletDoc {
  _id: Types.ObjectId;
  ownerId: Types.ObjectId;
  ownerType: 'SELLER';
  balanceMinor: bigint;
  currency: 'UZS';
  state: WalletState;
  lowBalanceThresholdMinor: bigint;
  deactivateBelowMinor: bigint;
  graceHours: number;
  belowFloorSince: Date | null;
  lastEntryAt: Date | null;
  lifetimeChargedMinor: bigint;
  lifetimeCreditedMinor: bigint;
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const walletSchema = new Schema<WalletDoc>(
  {
    ownerId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    ownerType: { type: String, enum: ['SELLER'], required: true, default: 'SELLER' },
    // May be negative: a commission charge is never refused for lack of funds.
    balanceMinor: { type: BigInt, required: true, default: 0n },
    currency: { type: String, enum: ['UZS'], required: true, default: 'UZS' },
    state: { type: String, enum: Object.values(WalletState), required: true, default: WalletState.ACTIVE },
    lowBalanceThresholdMinor: { type: BigInt, required: true, default: 0n },
    deactivateBelowMinor: { type: BigInt, required: true, default: 0n },
    graceHours: { type: Number, required: true, default: 0, min: 0, max: 720 },
    belowFloorSince: { type: Date, default: null },
    lastEntryAt: { type: Date, default: null },
    lifetimeChargedMinor: { type: BigInt, required: true, default: 0n },
    lifetimeCreditedMinor: { type: BigInt, required: true, default: 0n },
    schemaVersion: { type: Number, required: true, default: 1 },
  },
  { timestamps: true, collection: 'wallets', strict: 'throw' },
);

walletSchema.index({ ownerId: 1 }, { unique: true });
// The deactivation sweep reads this.
walletSchema.index(
  { state: 1, belowFloorSince: 1 },
  { partialFilterExpression: { state: WalletState.LOW } },
);

export const WalletModel: Model<WalletDoc> = model<WalletDoc>('Wallet', walletSchema);
