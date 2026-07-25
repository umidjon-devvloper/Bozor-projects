import { Types, type ClientSession } from 'mongoose';
import {
  PaymentTransactionModel,
  type PaymentTransactionDoc,
} from '../models/paymentTransaction.model.js';
import type { PaymentProvider, PaymentPurpose } from '../payments.constants.js';
import type { StoredTransaction } from '../services/paymeProtocol.js';

export interface PaymentRecord extends StoredTransaction {
  provider: PaymentProvider;
  purpose: PaymentPurpose;
  ownerId: string;
  journalEntryId: string | null;
}

function toRecord(doc: PaymentTransactionDoc): PaymentRecord {
  return {
    id: doc._id.toString(),
    provider: doc.provider,
    purpose: doc.purpose,
    providerTransactionId: doc.providerTransactionId,
    ownerId: doc.ownerId.toString(),
    amountMinor: doc.amountMinor,
    state: doc.state,
    reason: doc.reason,
    journalEntryId: doc.journalEntryId ? doc.journalEntryId.toString() : null,
    createdAt: doc.createdAt,
    performedAt: doc.performedAt,
    cancelledAt: doc.cancelledAt,
  };
}

export const paymentTransactionRepository = {
  async findByProviderId(
    provider: PaymentProvider,
    providerTransactionId: string,
  ): Promise<PaymentRecord | null> {
    const doc = await PaymentTransactionModel.findOne({
      provider,
      providerTransactionId,
    }).lean<PaymentTransactionDoc>();
    return doc ? toRecord(doc) : null;
  },

  async create(input: {
    provider: PaymentProvider;
    providerTransactionId: string;
    providerReference: string | null;
    purpose: PaymentPurpose;
    ownerId: string;
    amountMinor: bigint;
    state: number;
    rawAccount: Record<string, unknown>;
  }): Promise<PaymentRecord> {
    const doc = await PaymentTransactionModel.create({
      ...input,
      ownerId: new Types.ObjectId(input.ownerId),
      reason: null,
      journalEntryId: null,
      performedAt: null,
      cancelledAt: null,
      schemaVersion: 1,
    });
    return toRecord(doc.toObject<PaymentTransactionDoc>());
  },

  /**
   * Moves a transaction to performed, but only from created.
   *
   * A compare-and-set on `state`, so two concurrent PerformTransaction calls — which both
   * providers will make — cannot both post a journal entry. The loser sees `null` and returns
   * the stored answer instead of crediting the wallet twice.
   */
  async markPerformed(
    id: string,
    journalEntryId: string,
    performedAt: Date,
    fromState: number,
    toState: number,
    session: ClientSession,
  ): Promise<boolean> {
    const result = await PaymentTransactionModel.updateOne(
      { _id: new Types.ObjectId(id), state: fromState },
      {
        $set: {
          state: toState,
          performedAt,
          journalEntryId: new Types.ObjectId(journalEntryId),
        },
      },
      { session },
    );
    return result.modifiedCount === 1;
  },

  async markCancelled(
    id: string,
    state: number,
    reason: number,
    cancelledAt: Date,
    session?: ClientSession,
  ): Promise<boolean> {
    const result = await PaymentTransactionModel.updateOne(
      { _id: new Types.ObjectId(id), state: { $nin: [state] } },
      { $set: { state, reason, cancelledAt } },
      session ? { session } : {},
    );
    return result.modifiedCount === 1;
  },

  /** Created transactions older than the cutoff, for the timeout sweeper. */
  async findTimedOut(createdState: number, before: Date, limit: number): Promise<PaymentRecord[]> {
    const docs = await PaymentTransactionModel.find({
      state: createdState,
      createdAt: { $lt: before },
    })
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean<PaymentTransactionDoc[]>();
    return docs.map(toRecord);
  },

  async listForOwner(ownerId: string, limit: number): Promise<PaymentRecord[]> {
    const docs = await PaymentTransactionModel.find({ ownerId: new Types.ObjectId(ownerId) })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean<PaymentTransactionDoc[]>();
    return docs.map(toRecord);
  },
};
