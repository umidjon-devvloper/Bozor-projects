import { Types, type ClientSession } from 'mongoose';
import { CheckoutQuoteModel, type CheckoutQuoteDoc, type QuoteGroup } from '../models/checkoutQuote.model.js';

export interface QuoteRecord extends Omit<CheckoutQuoteDoc, '_id' | 'buyerId'> {
  id: string;
  buyerId: string;
}

function toRecord(doc: CheckoutQuoteDoc): QuoteRecord {
  const { _id, buyerId, ...rest } = doc;
  return { ...rest, id: _id.toString(), buyerId: buyerId.toString() };
}

export const quoteRepository = {
  async create(
    input: {
      quoteId: string;
      buyerId: string;
      groups: QuoteGroup[];
      grandTotal: bigint;
      paymentMode: 'CASH_ON_PICKUP' | 'PREPAID_ONLINE';
      contentHash: string;
      expiresAt: Date;
    },
    session: ClientSession,
  ): Promise<QuoteRecord> {
    const [doc] = await CheckoutQuoteModel.create(
      [
        {
          quoteId: input.quoteId,
          buyerId: new Types.ObjectId(input.buyerId),
          groups: input.groups,
          grandTotal: input.grandTotal,
          paymentMode: input.paymentMode,
          contentHash: input.contentHash,
          expiresAt: input.expiresAt,
        },
      ],
      { session },
    );
    if (!doc) throw new Error('Quote creation returned no document');
    return toRecord(doc.toObject<CheckoutQuoteDoc>());
  },

  async findByQuoteId(quoteId: string): Promise<QuoteRecord | null> {
    const doc = await CheckoutQuoteModel.findOne({ quoteId }).lean<CheckoutQuoteDoc>();
    return doc ? toRecord(doc) : null;
  },

  /**
   * Retires a buyer's previous live quotes.
   *
   * Only one offer may be outstanding at a time; otherwise a buyer could hold stock through
   * several quotes at once and starve everyone else while deciding.
   */
  async supersedeActive(buyerId: string, session: ClientSession): Promise<string[]> {
    const active = await CheckoutQuoteModel.find({ buyerId, status: 'ACTIVE' })
      .select('quoteId')
      .session(session)
      .lean<Array<{ quoteId: string }>>();
    if (active.length === 0) return [];

    await CheckoutQuoteModel.updateMany(
      { buyerId, status: 'ACTIVE' },
      { $set: { status: 'SUPERSEDED' } },
      { session },
    );
    return active.map((quote) => quote.quoteId);
  },

  /**
   * Marks a quote spent.
   *
   * The status filter is the guard against a double-submit becoming two order groups: the
   * second call matches nothing. The unique index on `order_groups.quoteId` is the backstop.
   */
  async consume(quoteId: string, orderGroupId: string, session: ClientSession): Promise<boolean> {
    const result = await CheckoutQuoteModel.updateOne(
      { quoteId, status: 'ACTIVE' },
      {
        $set: {
          status: 'CONSUMED',
          consumedAt: new Date(),
          consumedByOrderGroupId: new Types.ObjectId(orderGroupId),
        },
      },
      { session },
    );
    if (result.modifiedCount !== 1) {
      throw new Error(`Quote ${quoteId} was already consumed`);
    }
    return true;
  },

  async markExpired(quoteId: string): Promise<void> {
    await CheckoutQuoteModel.updateOne({ quoteId, status: 'ACTIVE' }, { $set: { status: 'EXPIRED' } });
  },
};
