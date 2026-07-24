import { Types, type ClientSession } from 'mongoose';
import { Money } from '@bozorlar/money';
import { Account, EntrySide, assertBalanced, walletDelta, type LedgerLine } from '@bozorlar/domain';
import { JournalEntryModel, type JournalEntryDoc, type JournalLine } from './models/journalEntry.model.js';
import { WalletModel, type WalletDoc } from './models/wallet.model.js';
import type { EntryType } from './constants.js';

export interface JournalEntryRecord {
  id: string;
  entryKey: string;
  type: EntryType;
  occurredAt: Date;
  lines: Array<{ account: Account; side: EntrySide; amount: Money; walletId: string | null }>;
  total: Money;
  reference: { type: string; id: string } | null;
  memo: string | null;
  createdAt: Date;
}

function toRecord(doc: JournalEntryDoc): JournalEntryRecord {
  return {
    id: doc._id.toString(),
    entryKey: doc.entryKey,
    type: doc.type,
    occurredAt: doc.occurredAt,
    lines: doc.lines.map((line) => ({
      account: line.account,
      side: line.side,
      amount: Money.of(line.amountMinor),
      walletId: line.walletId?.toString() ?? null,
    })),
    total: Money.of(doc.totalMinor),
    reference: doc.reference,
    memo: doc.memo,
    createdAt: doc.createdAt,
  };
}

export interface PostEntryInput {
  entryKey: string;
  type: EntryType;
  occurredAt: Date;
  lines: Array<LedgerLine & { walletId?: string | null; ownerId?: string | null }>;
  reference?: { type: string; id: string } | null;
  memo?: string | null;
  createdBy?: string | null;
  reversesEntryId?: string | null;
}

export const ledgerRepository = {
  /**
   * Posts an entry and moves the affected wallet, in one transaction.
   *
   * The balance assertion runs before anything is written, and the unique `entryKey` makes a
   * redelivered event a no-op rather than a second charge. Both matter: the first stops a bug
   * corrupting the books, the second stops the message bus doing it.
   */
  async post(input: PostEntryInput, session: ClientSession): Promise<JournalEntryRecord> {
    assertBalanced(input.lines);

    const lines: JournalLine[] = input.lines.map((line) => ({
      account: line.account,
      side: line.side,
      amountMinor: line.amountMinor,
      walletId: line.walletId ? new Types.ObjectId(line.walletId) : null,
      ownerId: line.ownerId ? new Types.ObjectId(line.ownerId) : null,
    }));
    const totalMinor = lines
      .filter((line) => line.side === EntrySide.DEBIT)
      .reduce((sum, line) => sum + line.amountMinor, 0n);

    const [doc] = await JournalEntryModel.create(
      [
        {
          entryKey: input.entryKey,
          type: input.type,
          occurredAt: input.occurredAt,
          lines,
          totalMinor,
          reference: input.reference ?? null,
          memo: input.memo ?? null,
          createdBy: input.createdBy ? new Types.ObjectId(input.createdBy) : null,
          reversesEntryId: input.reversesEntryId ? new Types.ObjectId(input.reversesEntryId) : null,
        },
      ],
      { session },
    );
    if (!doc) throw new Error('Journal entry creation returned no document');

    const delta = walletDelta(input.lines);
    const walletId = input.lines.find((line) => line.walletId)?.walletId;
    if (delta !== 0n && walletId) {
      await WalletModel.updateOne(
        { _id: walletId },
        {
          $inc: {
            balanceMinor: delta,
            ...(delta < 0n ? { lifetimeChargedMinor: -delta } : { lifetimeCreditedMinor: delta }),
          },
          $set: { lastEntryAt: input.occurredAt },
        },
        { session },
      );
    }

    return toRecord(doc.toObject<JournalEntryDoc>());
  },

  async findByKey(entryKey: string): Promise<JournalEntryRecord | null> {
    const doc = await JournalEntryModel.findOne({ entryKey }).lean<JournalEntryDoc>();
    return doc ? toRecord(doc) : null;
  },

  async findByReference(type: string, id: string): Promise<JournalEntryRecord[]> {
    const docs = await JournalEntryModel.find({ 'reference.type': type, 'reference.id': id })
      .sort({ occurredAt: 1 })
      .lean<JournalEntryDoc[]>();
    return docs.map(toRecord);
  },

  async statement(
    walletId: string,
    limit: number,
    before?: Date,
  ): Promise<JournalEntryRecord[]> {
    const filter: Record<string, unknown> = { 'lines.walletId': new Types.ObjectId(walletId) };
    if (before) filter.occurredAt = { $lt: before };
    const docs = await JournalEntryModel.find(filter)
      .sort({ occurredAt: -1 })
      .limit(limit)
      .lean<JournalEntryDoc[]>();
    return docs.map(toRecord);
  },

  /**
   * Recomputes a wallet's balance from the journal.
   *
   * The materialised balance is a cache; this is the authority. Any divergence means a write
   * escaped a transaction, which is worth an alert rather than a silent correction.
   */
  async recomputeBalance(walletId: string): Promise<bigint> {
    const docs = await JournalEntryModel.find(
      { 'lines.walletId': new Types.ObjectId(walletId) },
      { lines: 1 },
    ).lean<Array<Pick<JournalEntryDoc, 'lines'>>>();

    let balance = 0n;
    for (const doc of docs) {
      for (const line of doc.lines) {
        if (line.account !== Account.SELLER_WALLET) continue;
        if (line.walletId?.toString() !== walletId) continue;
        balance += line.side === EntrySide.CREDIT ? line.amountMinor : -line.amountMinor;
      }
    }
    return balance;
  },

  /** Global integrity probe: every entry in the book must balance. */
  async findUnbalanced(limit: number): Promise<string[]> {
    const docs = await JournalEntryModel.find({}, { entryKey: 1, lines: 1 })
      .sort({ occurredAt: -1 })
      .limit(limit)
      .lean<Array<Pick<JournalEntryDoc, 'entryKey' | 'lines'>>>();
    const broken: string[] = [];
    for (const doc of docs) {
      const debits = doc.lines
        .filter((line) => line.side === EntrySide.DEBIT)
        .reduce((sum, line) => sum + line.amountMinor, 0n);
      const credits = doc.lines
        .filter((line) => line.side === EntrySide.CREDIT)
        .reduce((sum, line) => sum + line.amountMinor, 0n);
      if (debits !== credits) broken.push(doc.entryKey);
    }
    return broken;
  },

  toWalletRecord(doc: WalletDoc) {
    return {
      id: doc._id.toString(),
      ownerId: doc.ownerId.toString(),
      balance: Money.of(doc.balanceMinor),
      state: doc.state,
      lowBalanceThreshold: Money.of(doc.lowBalanceThresholdMinor),
      deactivateBelow: Money.of(doc.deactivateBelowMinor),
      graceHours: doc.graceHours,
      belowFloorSince: doc.belowFloorSince,
      lifetimeCharged: Money.of(doc.lifetimeChargedMinor),
      lifetimeCredited: Money.of(doc.lifetimeCreditedMinor),
      lastEntryAt: doc.lastEntryAt,
    };
  },
};

export type WalletRecord = ReturnType<typeof ledgerRepository.toWalletRecord>;
