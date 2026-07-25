import { Schema, model, type Model, type Types } from 'mongoose';
import { PaymentProvider, PaymentPurpose } from '../payments.constants.js';

/**
 * One payment attempt at one provider.
 *
 * The row exists from the moment a provider first mentions a transaction id, not from the
 * moment money moves, because both providers retry every call and the retry must find the same
 * row. `providerTransactionId` unique per provider is what makes that true at the database
 * level rather than in a service that could race with itself.
 *
 * `state` holds Payme's own integers even for Click rows; Click has no state field of its own,
 * so its lifecycle is mapped onto the same four values. One vocabulary for two providers is
 * worth more than a faithful copy of each.
 */
export interface PaymentTransactionDoc {
  _id: Types.ObjectId;
  provider: PaymentProvider;
  providerTransactionId: string;
  /** Click's paydoc id, or Payme's `time` — whatever the provider uses for reconciliation. */
  providerReference: string | null;

  purpose: PaymentPurpose;
  /** Who the money is for. A seller, for a top-up. */
  ownerId: Types.ObjectId;
  amountMinor: bigint;

  state: number;
  reason: number | null;

  /** The journal entry this produced, once it produced one. Null until performed. */
  journalEntryId: Types.ObjectId | null;

  performedAt: Date | null;
  cancelledAt: Date | null;

  /** The raw first request, kept for disputes with the provider. */
  rawAccount: Record<string, unknown>;

  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const paymentTransactionSchema = new Schema<PaymentTransactionDoc>(
  {
    provider: { type: String, enum: Object.values(PaymentProvider), required: true },
    providerTransactionId: { type: String, required: true, maxlength: 64 },
    providerReference: { type: String, default: null, maxlength: 64 },

    purpose: { type: String, enum: Object.values(PaymentPurpose), required: true },
    ownerId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    amountMinor: { type: BigInt, required: true },

    state: { type: Number, required: true },
    reason: { type: Number, default: null },

    journalEntryId: { type: Schema.Types.ObjectId, default: null },
    performedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },

    rawAccount: { type: Schema.Types.Mixed, required: true, default: {} },

    schemaVersion: { type: Number, required: true, default: 1 },
  },
  { timestamps: true, collection: 'payment_transactions', strict: 'throw', minimize: false },
);

// The idempotency guarantee both protocols require, enforced where a race cannot get past it.
paymentTransactionSchema.index(
  { provider: 1, providerTransactionId: 1 },
  { unique: true, name: 'uniq_provider_transaction' },
);
// A seller's payment history, and the admin reconciliation view.
paymentTransactionSchema.index({ ownerId: 1, createdAt: -1 });
// The timeout sweeper: created transactions, oldest first.
paymentTransactionSchema.index({ state: 1, createdAt: 1 });

export const PaymentTransactionModel: Model<PaymentTransactionDoc> =
  model<PaymentTransactionDoc>('PaymentTransaction', paymentTransactionSchema);
