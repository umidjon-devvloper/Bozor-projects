import { Types, type ClientSession } from 'mongoose';
import { Money, Quantity } from '@bozorlar/money';
import { OrderAdjustmentModel, type OrderAdjustmentDoc } from '../models/orderAdjustment.model.js';
import { AdjustmentStatus } from '../orders.constants.js';

export interface AdjustmentLineRecord {
  lineId: string;
  orderedQty: Quantity;
  proposedQty: Quantity;
  deltaBp: number;
  oldLineTotal: Money;
  newLineTotal: Money;
}

export interface AdjustmentRecord {
  id: string;
  orderId: string;
  orderNo: string;
  shopId: string;
  buyerId: string;
  lines: AdjustmentLineRecord[];
  oldTotal: Money;
  newTotal: Money;
  status: AdjustmentStatus;
  expiresAt: Date;
  createdAt: Date;
}

function toRecord(doc: OrderAdjustmentDoc, unit: string): AdjustmentRecord {
  return {
    id: doc._id.toString(),
    orderId: doc.orderId.toString(),
    orderNo: doc.orderNo,
    shopId: doc.shopId.toString(),
    buyerId: doc.buyerId.toString(),
    lines: doc.lines.map((line) => ({
      lineId: line.lineId,
      orderedQty: Quantity.of(line.orderedQtyMilli, unit),
      proposedQty: Quantity.of(line.proposedQtyMilli, unit),
      deltaBp: line.deltaBp,
      oldLineTotal: Money.of(line.oldLineTotal),
      newLineTotal: Money.of(line.newLineTotal),
    })),
    oldTotal: Money.of(doc.oldTotal),
    newTotal: Money.of(doc.newTotal),
    status: doc.status,
    expiresAt: doc.expiresAt,
    createdAt: doc.createdAt,
  };
}

export const adjustmentRepository = {
  async create(
    input: Omit<OrderAdjustmentDoc, '_id' | 'createdAt' | 'updatedAt' | 'schemaVersion' | 'respondedAt' | 'status'>,
    session: ClientSession,
  ): Promise<string> {
    const [doc] = await OrderAdjustmentModel.create([input], { session });
    if (!doc) throw new Error('Adjustment creation returned no document');
    return doc._id.toString();
  },

  async findById(id: string, unit: string): Promise<AdjustmentRecord | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const doc = await OrderAdjustmentModel.findById(id).lean<OrderAdjustmentDoc>();
    return doc ? toRecord(doc, unit) : null;
  },

  async findPendingForOrder(orderId: string, unit: string): Promise<AdjustmentRecord | null> {
    const doc = await OrderAdjustmentModel.findOne({
      orderId: new Types.ObjectId(orderId),
      status: AdjustmentStatus.PENDING,
    }).lean<OrderAdjustmentDoc>();
    return doc ? toRecord(doc, unit) : null;
  },

  /** Status is in the filter, so two responses to the same adjustment cannot both apply. */
  async resolve(
    adjustmentId: string,
    status: AdjustmentStatus,
    session: ClientSession,
  ): Promise<boolean> {
    const result = await OrderAdjustmentModel.updateOne(
      { _id: adjustmentId, status: AdjustmentStatus.PENDING },
      { $set: { status, respondedAt: new Date() } },
      { session },
    );
    return result.modifiedCount === 1;
  },

  async findExpired(limit: number, now: Date): Promise<Array<{ id: string; orderId: string }>> {
    const docs = await OrderAdjustmentModel.find({
      status: AdjustmentStatus.PENDING,
      expiresAt: { $lte: now },
    })
      .limit(limit)
      .select('orderId')
      .lean<Array<{ _id: Types.ObjectId; orderId: Types.ObjectId }>>();
    return docs.map((doc) => ({ id: doc._id.toString(), orderId: doc.orderId.toString() }));
  },
};
