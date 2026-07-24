import { Types, type ClientSession } from 'mongoose';
import { Money, Quantity } from '@bozorlar/money';
import { OrderStatus, deriveGroupStatus, type GroupStatus } from '@bozorlar/domain';
import type { LocalizedText } from '@bozorlar/types';
import { OrderModel, type OrderDoc, type OrderLine, type StatusChange } from '../models/order.model.js';
import { OrderGroupModel, type OrderGroupDoc } from '../models/orderGroup.model.js';
import type { AdjustmentStatus, CancelReasonCode, CommissionStatus } from '../orders.constants.js';
import type { ParsedQuery } from '../../../http/query.js';

export interface OrderLineRecord {
  lineId: string;
  productId: string;
  productName: LocalizedText;
  productSlug: string;
  imageKey: string | null;
  unit: string;
  unitPrice: Money;
  orderedQty: Quantity;
  confirmedQty: Quantity | null;
  tolerancePercent: number;
  lineTotal: Money;
  adjustmentStatus: AdjustmentStatus;
}

export interface OrderRecord {
  id: string;
  orderNo: string;
  groupId: string;
  buyerId: string;
  shopId: string;
  sellerId: string;
  marketId: string;
  shopSnapshot: OrderDoc['shopSnapshot'];
  buyerSnapshot: OrderDoc['buyerSnapshot'];
  lines: OrderLineRecord[];
  status: OrderStatus;
  statusHistory: StatusChange[];
  paymentMode: 'CASH_ON_PICKUP' | 'PREPAID_ONLINE';
  totals: { items: Money; adjustment: Money; discount: Money; delivery: Money; grand: Money };
  commissionStatus: CommissionStatus;
  commissionAmount: Money | null;
  pickupWindow: { from: Date; to: Date } | null;
  pickupCodeAttempts: number;
  acceptDeadline: Date | null;
  autoCompleteAt: Date | null;
  disputeDeadline: Date | null;
  cancelledBy: string | null;
  cancelReasonCode: CancelReasonCode | null;
  cancelReason: string | null;
  hasAdjustment: boolean;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toLine(line: OrderLine): OrderLineRecord {
  return {
    lineId: line.lineId,
    productId: line.productId.toString(),
    productName: line.productName,
    productSlug: line.productSlug,
    imageKey: line.imageKey,
    unit: line.unit,
    unitPrice: Money.of(line.unitPrice),
    orderedQty: Quantity.of(line.orderedQtyMilli, line.unit),
    confirmedQty: line.confirmedQtyMilli === null ? null : Quantity.of(line.confirmedQtyMilli, line.unit),
    tolerancePercent: line.tolerancePercent,
    lineTotal: Money.of(line.lineTotal),
    adjustmentStatus: line.adjustmentStatus,
  };
}

function toRecord(doc: OrderDoc): OrderRecord {
  return {
    id: doc._id.toString(),
    orderNo: doc.orderNo,
    groupId: doc.groupId.toString(),
    buyerId: doc.buyerId.toString(),
    shopId: doc.shopId.toString(),
    sellerId: doc.sellerId.toString(),
    marketId: doc.marketId.toString(),
    shopSnapshot: doc.shopSnapshot,
    buyerSnapshot: doc.buyerSnapshot,
    lines: doc.lines.map(toLine),
    status: doc.status,
    statusHistory: doc.statusHistory,
    paymentMode: doc.paymentMode,
    totals: {
      items: Money.of(doc.totals.items),
      adjustment: Money.of(doc.totals.adjustment),
      discount: Money.of(doc.totals.discount),
      delivery: Money.of(doc.totals.delivery),
      grand: Money.of(doc.totals.grand),
    },
    commissionStatus: doc.commission.status,
    commissionAmount: doc.commission.amount === null ? null : Money.of(doc.commission.amount),
    pickupWindow: doc.pickupWindow,
    pickupCodeAttempts: doc.pickupCodeAttempts,
    acceptDeadline: doc.acceptDeadline,
    autoCompleteAt: doc.autoCompleteAt,
    disputeDeadline: doc.disputeDeadline,
    cancelledBy: doc.cancelledBy,
    cancelReasonCode: doc.cancelReasonCode,
    cancelReason: doc.cancelReason,
    hasAdjustment: doc.hasAdjustment,
    note: doc.note,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export interface OrderGroupRecord {
  id: string;
  groupNo: string;
  buyerId: string;
  orderIds: string[];
  quoteId: string;
  paymentMode: 'CASH_ON_PICKUP' | 'PREPAID_ONLINE';
  totals: { items: Money; discount: Money; delivery: Money; grand: Money };
  derivedStatus: GroupStatus;
  createdAt: Date;
}

function toGroup(doc: OrderGroupDoc): OrderGroupRecord {
  return {
    id: doc._id.toString(),
    groupNo: doc.groupNo,
    buyerId: doc.buyerId.toString(),
    orderIds: doc.orderIds.map((id) => id.toString()),
    quoteId: doc.quoteId,
    paymentMode: doc.paymentMode,
    totals: {
      items: Money.of(doc.totals.items),
      discount: Money.of(doc.totals.discount),
      delivery: Money.of(doc.totals.delivery),
      grand: Money.of(doc.totals.grand),
    },
    derivedStatus: doc.derivedStatus,
    createdAt: doc.createdAt,
  };
}

export const orderRepository = {
  async createGroup(
    input: Omit<OrderGroupDoc, '_id' | 'createdAt' | 'updatedAt' | 'schemaVersion' | 'derivedStatus'>,
    session: ClientSession,
  ): Promise<string> {
    const [doc] = await OrderGroupModel.create([input], { session });
    if (!doc) throw new Error('Order group creation returned no document');
    return doc._id.toString();
  },

  async createOrder(
    input: Omit<
      OrderDoc,
      '_id' | 'createdAt' | 'updatedAt' | 'schemaVersion' | 'statusHistory' | 'pickupCodeAttempts'
    >,
    session: ClientSession,
  ): Promise<OrderRecord> {
    const [doc] = await OrderModel.create([input], { session });
    if (!doc) throw new Error('Order creation returned no document');
    return toRecord(doc.toObject<OrderDoc>());
  },

  async attachOrdersToGroup(
    groupId: string,
    orderIds: readonly string[],
    session: ClientSession,
  ): Promise<void> {
    await OrderGroupModel.updateOne(
      { _id: groupId },
      { $set: { orderIds: orderIds.map((id) => new Types.ObjectId(id)) } },
      { session },
    );
  },

  async findById(id: string): Promise<OrderRecord | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const doc = await OrderModel.findById(id).lean<OrderDoc>();
    return doc ? toRecord(doc) : null;
  },

  async findGroupById(id: string): Promise<OrderGroupRecord | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const doc = await OrderGroupModel.findById(id).lean<OrderGroupDoc>();
    return doc ? toGroup(doc) : null;
  },

  async findByGroup(groupId: string): Promise<OrderRecord[]> {
    const docs = await OrderModel.find({ groupId }).sort({ createdAt: 1 }).lean<OrderDoc[]>();
    return docs.map(toRecord);
  },

  async list(parsed: ParsedQuery, extraFilter: Record<string, unknown> = {}): Promise<OrderRecord[]> {
    const filter = parsed.cursorFilter
      ? { $and: [{ ...parsed.filter, ...extraFilter }, parsed.cursorFilter] }
      : { ...parsed.filter, ...extraFilter };
    const docs = await OrderModel.find(filter)
      .sort(parsed.sort)
      .limit(parsed.limit + 1)
      .lean<OrderDoc[]>();
    return docs.map(toRecord);
  },

  /**
   * Applies a transition atomically.
   *
   * `expectedStatus` is in the filter, which is what makes concurrent actors safe: a seller
   * accepting an order at the same instant the expiry sweeper cancels it produces exactly one
   * winner, and the loser is told the order moved rather than overwriting it.
   */
  async transition(
    orderId: string,
    expectedStatus: OrderStatus,
    next: OrderStatus,
    patch: Record<string, unknown>,
    change: Omit<StatusChange, 'at'>,
    session: ClientSession,
  ): Promise<OrderRecord | null> {
    const doc = await OrderModel.findOneAndUpdate(
      { _id: orderId, status: expectedStatus },
      {
        $set: { ...patch, status: next },
        $push: { statusHistory: { $each: [{ ...change, at: new Date() }], $slice: -50 } },
      },
      { new: true, runValidators: true, session },
    ).lean<OrderDoc>();
    return doc ? toRecord(doc) : null;
  },

  async updateOrder(
    orderId: string,
    patch: Record<string, unknown>,
    session?: ClientSession,
  ): Promise<OrderRecord | null> {
    const doc = await OrderModel.findByIdAndUpdate(
      orderId,
      { $set: patch },
      { new: true, runValidators: true, ...(session ? { session } : {}) },
    ).lean<OrderDoc>();
    return doc ? toRecord(doc) : null;
  },

  async incrementPickupAttempts(orderId: string, session: ClientSession): Promise<number> {
    const doc = await OrderModel.findByIdAndUpdate(
      orderId,
      { $inc: { pickupCodeAttempts: 1 } },
      { new: true, projection: { pickupCodeAttempts: 1 }, session },
    ).lean<Pick<OrderDoc, 'pickupCodeAttempts'>>();
    return doc?.pickupCodeAttempts ?? 0;
  },

  async pickupCodeHash(orderId: string): Promise<string | null> {
    const doc = await OrderModel.findById(orderId, { pickupCodeHash: 1 }).lean<
      Pick<OrderDoc, 'pickupCodeHash'>
    >();
    return doc?.pickupCodeHash ?? null;
  },

  /** Recomputes the group's derived status from its children (ADR-0007). */
  async refreshGroupStatus(groupId: string, session: ClientSession): Promise<GroupStatus> {
    const children = await OrderModel.find({ groupId }, { status: 1 })
      .session(session)
      .lean<Array<Pick<OrderDoc, 'status'>>>();
    const derived = deriveGroupStatus(children.map((child) => child.status));
    await OrderGroupModel.updateOne({ _id: groupId }, { $set: { derivedStatus: derived } }, { session });
    return derived;
  },

  async findDueForExpiry(limit: number, now: Date): Promise<OrderRecord[]> {
    const docs = await OrderModel.find({ status: OrderStatus.PENDING, acceptDeadline: { $lte: now } })
      .limit(limit)
      .lean<OrderDoc[]>();
    return docs.map(toRecord);
  },

  async findDueForAutoComplete(limit: number, now: Date): Promise<OrderRecord[]> {
    const docs = await OrderModel.find({ status: OrderStatus.PICKED_UP, autoCompleteAt: { $lte: now } })
      .limit(limit)
      .lean<OrderDoc[]>();
    return docs.map(toRecord);
  },
};
