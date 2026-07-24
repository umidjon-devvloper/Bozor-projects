import { Schema, model, type Model, type Types } from 'mongoose';
import { Account, EntrySide, assertBalanced } from '@bozorlar/domain';
import { EntryType } from '../constants.js';

/**
 * A double-entry journal entry (LEDGER.md).
 *
 * Append-only and immutable. A correction is a new, opposite entry — never an edit — because
 * a ledger whose past can change is a ledger that cannot answer "what did we bill in March"
 * more than once.
 */
export interface JournalLine {
  account: Account;
  side: EntrySide;
  amountMinor: bigint;
  walletId: Types.ObjectId | null;
  ownerId: Types.ObjectId | null;
}

export interface JournalEntryDoc {
  _id: Types.ObjectId;
  /**
   * Natural key, unique. Derived from what caused the entry (`commission:<orderId>`), so a
   * redelivered event cannot charge twice — at-least-once delivery is the only guarantee the
   * outbox gives (ADR-0012).
   */
  entryKey: string;
  type: EntryType;
  occurredAt: Date;
  lines: JournalLine[];
  totalMinor: bigint;
  reference: { type: string; id: string } | null;
  memo: string | null;
  createdBy: Types.ObjectId | null;
  /** Set on the entry this one reverses, and vice versa. */
  reversesEntryId: Types.ObjectId | null;
  schemaVersion: number;
  createdAt: Date;
}

const journalLineSchema = new Schema<JournalLine>(
  {
    account: { type: String, enum: Object.values(Account), required: true },
    side: { type: String, enum: Object.values(EntrySide), required: true },
    amountMinor: { type: BigInt, required: true },
    walletId: { type: Schema.Types.ObjectId, default: null },
    ownerId: { type: Schema.Types.ObjectId, default: null },
  },
  { _id: false },
);

const journalEntrySchema = new Schema<JournalEntryDoc>(
  {
    entryKey: { type: String, required: true, maxlength: 128 },
    type: { type: String, enum: Object.values(EntryType), required: true },
    occurredAt: { type: Date, required: true },
    lines: {
      type: [journalLineSchema],
      required: true,
      validate: {
        validator: (v: JournalLine[]) => v.length >= 2 && v.length <= 20,
        message: 'A journal entry has between 2 and 20 lines',
      },
    },
    totalMinor: { type: BigInt, required: true },
    reference: {
      type: new Schema(
        { type: { type: String, required: true, maxlength: 32 }, id: { type: String, required: true } },
        { _id: false },
      ),
      default: null,
    },
    memo: { type: String, default: null, maxlength: 500 },
    createdBy: { type: Schema.Types.ObjectId, default: null },
    reversesEntryId: { type: Schema.Types.ObjectId, default: null },
    schemaVersion: { type: Number, required: true, default: 1 },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'journal_entries', strict: 'throw' },
);

journalEntrySchema.index({ entryKey: 1 }, { unique: true });
// The wallet statement: every line touching a wallet, newest first.
journalEntrySchema.index({ 'lines.walletId': 1, occurredAt: -1 });
journalEntrySchema.index({ type: 1, occurredAt: -1 });
journalEntrySchema.index({ 'reference.type': 1, 'reference.id': 1 });
journalEntrySchema.index({ occurredAt: -1 });

journalEntrySchema.pre('validate', function enforceBalance(next) {
  try {
    assertBalanced(this.lines);
  } catch (error) {
    next(error as Error);
    return;
  }
  const debits = this.lines
    .filter((line) => line.side === 'DEBIT')
    .reduce((sum, line) => sum + line.amountMinor, 0n);
  if (debits !== this.totalMinor) {
    next(new Error('totalMinor must equal the sum of the debit lines'));
    return;
  }
  next();
});

function blockMutation(next: (error?: Error) => void): void {
  next(new Error('journal_entries is immutable; post a reversing entry instead'));
}
journalEntrySchema.pre('updateOne', function (next) { blockMutation(next); });
journalEntrySchema.pre('updateMany', function (next) { blockMutation(next); });
journalEntrySchema.pre('findOneAndUpdate', function (next) { blockMutation(next); });
journalEntrySchema.pre('deleteOne', function (next) { blockMutation(next); });
journalEntrySchema.pre('deleteMany', function (next) { blockMutation(next); });

export const JournalEntryModel: Model<JournalEntryDoc> = model<JournalEntryDoc>(
  'JournalEntry',
  journalEntrySchema,
);
