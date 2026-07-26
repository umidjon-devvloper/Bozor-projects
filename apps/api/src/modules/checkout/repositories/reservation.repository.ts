import mongoose, { Types, type ClientSession } from 'mongoose';
import type { Quantity } from '@bozorlar/money';
import { StockReservationModel, type StockReservationDoc } from '../models/stockReservation.model.js';
import { ReservationStatus } from '../checkout.constants.js';

const Long = mongoose.mongo.Long;

export interface ReservationRecord {
  id: string;
  productId: string;
  shopId: string;
  buyerId: string;
  holderType: 'QUOTE' | 'ORDER';
  holderId: string;
  qtyMilli: bigint;
  status: ReservationStatus;
  expiresAt: Date;
}

function toRecord(doc: StockReservationDoc): ReservationRecord {
  return {
    id: doc._id.toString(),
    productId: doc.productId.toString(),
    shopId: doc.shopId.toString(),
    buyerId: doc.buyerId.toString(),
    holderType: doc.holderType,
    holderId: doc.holderId,
    qtyMilli: doc.qtyMilli,
    status: doc.status,
    expiresAt: doc.expiresAt,
  };
}

export const reservationRepository = {
  /**
   * Takes a hold, atomically (ADR-0032).
   *
   * The whole correctness of checkout sits in this filter. Availability is evaluated *inside*
   * the update, by the server, against the document as it exists at that instant — there is no
   * read-then-write window for a second buyer to slip through. Two buyers racing for the last
   * 2.5 kg produce one match and one `modifiedCount: 0`.
   */
  async tryHold(
    productId: string,
    qty: Quantity,
    session: ClientSession,
  ): Promise<boolean> {
    const result = await mongoose.connection
      .collection('products')
      .updateOne(
        {
          _id: new Types.ObjectId(productId),
          deletedAt: null,
          $expr: {
            $gte: [
              { $subtract: ['$stockQtyMilli', '$reservedQtyMilli'] },
              Long.fromBigInt(qty.milli),
            ],
          },
        },
        { $inc: { reservedQtyMilli: Long.fromBigInt(qty.milli) } },
        { session },
      );
    return result.modifiedCount === 1;
  },

  /** Gives stock back. Never conditional: releasing must always succeed. */
  async releaseHold(productId: string, qty: Quantity, session: ClientSession): Promise<void> {
    await mongoose.connection
      .collection('products')
      .updateOne(
        { _id: new Types.ObjectId(productId) },
        { $inc: { reservedQtyMilli: Long.fromBigInt(-qty.milli) } },
        { session },
      );
  },

  /**
   * Converts a hold into a committed sale: stock and reservation both fall by the quantity.
   *
   * Consumed by the orders module when an order is created; kept here because it is the other
   * half of `tryHold` and belongs beside it.
   */
  async commitHold(productId: string, qty: Quantity, session: ClientSession): Promise<void> {
    await mongoose.connection.collection('products').updateOne(
      { _id: new Types.ObjectId(productId) },
      {
        $inc: {
          stockQtyMilli: Long.fromBigInt(-qty.milli),
          reservedQtyMilli: Long.fromBigInt(-qty.milli),
        },
      },
      { session },
    );
  },

  async create(
    input: {
      productId: string;
      shopId: string;
      buyerId: string;
      holderType: 'QUOTE' | 'ORDER';
      holderId: string;
      qty: Quantity;
      expiresAt: Date;
    },
    session: ClientSession,
  ): Promise<void> {
    await StockReservationModel.create(
      [
        {
          productId: new Types.ObjectId(input.productId),
          shopId: new Types.ObjectId(input.shopId),
          buyerId: new Types.ObjectId(input.buyerId),
          holderType: input.holderType,
          holderId: input.holderId,
          qtyMilli: input.qty.milli,
          expiresAt: input.expiresAt,
        },
      ],
      { session },
    );
  },

  /**
   * The session is not optional in practice: every caller releases these rows inside a
   * transaction, and reading them outside it means acting on a picture that another
   * transaction may already have changed.
   */
  async findActiveByHolder(
    holderId: string,
    session?: ClientSession,
  ): Promise<ReservationRecord[]> {
    const docs = await StockReservationModel.find({
      holderId,
      status: ReservationStatus.ACTIVE,
    })
      .session(session ?? null)
      .lean<StockReservationDoc[]>();
    return docs.map(toRecord);
  },

  /**
   * Claims one reservation for release.
   *
   * Returns whether this caller is the one that moved it out of ACTIVE. Stock must only be
   * given back by whoever wins here: the checkout path releases a superseded quote's holds at
   * the same time as the sweeper may be expiring them, and both decrementing one hold makes a
   * product look like it has stock nobody is holding.
   */
  async claimForRelease(
    reservationId: string,
    status: ReservationStatus,
    session: ClientSession,
  ): Promise<boolean> {
    const result = await StockReservationModel.updateOne(
      { _id: new Types.ObjectId(reservationId), status: ReservationStatus.ACTIVE },
      { $set: { status, releasedAt: new Date() } },
      { session },
    );
    return result.modifiedCount === 1;
  },

  async markStatus(
    ids: readonly string[],
    status: ReservationStatus,
    session: ClientSession,
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await StockReservationModel.updateMany(
      { _id: { $in: ids.map((id) => new Types.ObjectId(id)) }, status: ReservationStatus.ACTIVE },
      { $set: { status, releasedAt: new Date() } },
      { session },
    );
    return result.modifiedCount;
  },

  async findExpired(limit: number, now: Date): Promise<ReservationRecord[]> {
    const docs = await StockReservationModel.find({
      status: ReservationStatus.ACTIVE,
      expiresAt: { $lte: now },
    })
      .limit(limit)
      .lean<StockReservationDoc[]>();
    return docs.map(toRecord);
  },

  /** Sum of live holds on a product. Used by the reconciliation check, not the hot path. */
  async activeQtyForProduct(productId: string): Promise<bigint> {
    const docs = await StockReservationModel.find({
      productId: new Types.ObjectId(productId),
      status: ReservationStatus.ACTIVE,
    })
      .select('qtyMilli')
      .lean<Array<{ qtyMilli: bigint }>>();
    return docs.reduce((sum, doc) => sum + doc.qtyMilli, 0n);
  },
};
