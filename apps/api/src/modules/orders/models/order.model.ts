import { Schema, model, type Model, type Types } from 'mongoose';
import { OrderStatus } from '@bozorlar/domain';
import type { LocalizedText } from '@bozorlar/types';
import {
  AdjustmentStatus,
  CancelReasonCode,
  CommissionStatus,
  MAX_ORDER_LINES,
} from '../orders.constants.js';

/**
 * A line, frozen at creation.
 *
 * Every displayable fact is copied rather than referenced. A seller renaming a product, or
 * archiving it, or changing its price must not rewrite an order placed last month — the
 * receipt has to keep saying what the buyer actually agreed to (DOMAIN_MODEL.md 1.5).
 */
export interface OrderLine {
  lineId: string;
  productId: Types.ObjectId;
  productName: LocalizedText;
  productSlug: string;
  imageKey: string | null;
  unit: string;
  unitPrice: bigint;
  orderedQtyMilli: bigint;
  /** Null until the seller weighs it at handover. */
  confirmedQtyMilli: bigint | null;
  tolerancePercent: number;
  lineTotal: bigint;
  adjustmentStatus: AdjustmentStatus;
}

export interface StatusChange {
  from: OrderStatus;
  to: OrderStatus;
  at: Date;
  by: Types.ObjectId | null;
  actor: string;
  reasonCode: CancelReasonCode | null;
  reason: string | null;
}

export interface OrderDoc {
  _id: Types.ObjectId;
  orderNo: string;
  groupId: Types.ObjectId;
  buyerId: Types.ObjectId;
  shopId: Types.ObjectId;
  /** Snapshot of the shop owner at creation: transferring a shop must not move old liability. */
  sellerId: Types.ObjectId;
  marketId: Types.ObjectId;
  districtId: Types.ObjectId;
  regionId: Types.ObjectId;
  shopSnapshot: {
    name: LocalizedText;
    slug: string;
    phone: string;
    sectionCode: string | null;
    stallNo: string | null;
    marketName: LocalizedText;
  };
  buyerSnapshot: { name: string; phone: string };
  lines: OrderLine[];
  status: OrderStatus;
  statusHistory: StatusChange[];
  paymentMode: 'CASH_ON_PICKUP' | 'PREPAID_ONLINE';
  fulfilmentType: 'PICKUP' | 'COURIER';
  totals: { items: bigint; adjustment: bigint; discount: bigint; delivery: bigint; grand: bigint };
  commission: {
    ruleId: Types.ObjectId | null;
    percentBp: number | null;
    amount: bigint | null;
    status: CommissionStatus;
    journalEntryId: Types.ObjectId | null;
    chargedAt: Date | null;
    failureReason: string | null;
  };
  /** SHA-256 of the code. The plaintext exists only in the buyer's response. */
  pickupCodeHash: string | null;
  pickupCodeAttempts: number;
  pickupWindow: { from: Date; to: Date } | null;
  acceptDeadline: Date | null;
  autoCompleteAt: Date | null;
  disputeDeadline: Date | null;
  cancelledBy: string | null;
  cancelReasonCode: CancelReasonCode | null;
  cancelReason: string | null;
  cancelPenalised: boolean;
  hasAdjustment: boolean;
  note: string | null;
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const localized = {
  uz: { type: String, required: true, maxlength: 200 },
  uzCyrl: { type: String, maxlength: 200 },
  ru: { type: String, maxlength: 200 },
  en: { type: String, maxlength: 200 },
};

const lineSchema = new Schema<OrderLine>(
  {
    lineId: { type: String, required: true, maxlength: 32 },
    productId: { type: Schema.Types.ObjectId, required: true },
    productName: { type: localized, required: true },
    productSlug: { type: String, required: true, maxlength: 160 },
    imageKey: { type: String, default: null, maxlength: 256 },
    unit: { type: String, required: true, maxlength: 16 },
    unitPrice: { type: BigInt, required: true },
    orderedQtyMilli: { type: BigInt, required: true },
    confirmedQtyMilli: { type: BigInt, default: null },
    tolerancePercent: { type: Number, required: true },
    lineTotal: { type: BigInt, required: true },
    adjustmentStatus: {
      type: String,
      enum: Object.values(AdjustmentStatus),
      required: true,
      default: AdjustmentStatus.NONE,
    },
  },
  { _id: false },
);

const statusChangeSchema = new Schema<StatusChange>(
  {
    from: { type: String, enum: Object.values(OrderStatus), required: true },
    to: { type: String, enum: Object.values(OrderStatus), required: true },
    at: { type: Date, required: true, default: () => new Date() },
    by: { type: Schema.Types.ObjectId, default: null },
    actor: { type: String, required: true, maxlength: 16 },
    reasonCode: { type: String, enum: Object.values(CancelReasonCode), default: null },
    reason: { type: String, default: null, maxlength: 500 },
  },
  { _id: false },
);

const orderSchema = new Schema<OrderDoc>(
  {
    orderNo: { type: String, required: true, maxlength: 32 },
    groupId: { type: Schema.Types.ObjectId, required: true, ref: 'OrderGroup' },
    buyerId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    shopId: { type: Schema.Types.ObjectId, required: true, ref: 'Shop' },
    sellerId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    marketId: { type: Schema.Types.ObjectId, required: true },
    districtId: { type: Schema.Types.ObjectId, required: true },
    regionId: { type: Schema.Types.ObjectId, required: true },
    shopSnapshot: {
      name: { type: localized, required: true },
      slug: { type: String, required: true, maxlength: 140 },
      phone: { type: String, required: true, maxlength: 20 },
      sectionCode: { type: String, default: null, maxlength: 16 },
      stallNo: { type: String, default: null, maxlength: 16 },
      marketName: { type: localized, required: true },
    },
    buyerSnapshot: {
      name: { type: String, required: true, maxlength: 120 },
      phone: { type: String, required: true, maxlength: 20 },
    },
    lines: {
      type: [lineSchema],
      required: true,
      validate: {
        validator: (v: OrderLine[]) => v.length >= 1 && v.length <= MAX_ORDER_LINES,
        message: `An order must have between 1 and ${MAX_ORDER_LINES} lines`,
      },
    },
    status: { type: String, enum: Object.values(OrderStatus), required: true, default: OrderStatus.PENDING },
    statusHistory: { type: [statusChangeSchema], default: [] },
    paymentMode: { type: String, enum: ['CASH_ON_PICKUP', 'PREPAID_ONLINE'], required: true },
    fulfilmentType: { type: String, enum: ['PICKUP', 'COURIER'], required: true, default: 'PICKUP' },
    totals: {
      items: { type: BigInt, required: true },
      adjustment: { type: BigInt, required: true, default: 0n },
      discount: { type: BigInt, required: true, default: 0n },
      delivery: { type: BigInt, required: true, default: 0n },
      grand: { type: BigInt, required: true },
    },
    commission: {
      // Populated by the wallet module (Phase 6), which owns commission rules and the ledger.
      ruleId: { type: Schema.Types.ObjectId, default: null },
      percentBp: { type: Number, default: null },
      amount: { type: BigInt, default: null },
      status: {
        type: String,
        enum: Object.values(CommissionStatus),
        required: true,
        default: CommissionStatus.PENDING,
      },
      journalEntryId: { type: Schema.Types.ObjectId, default: null },
      chargedAt: { type: Date, default: null },
      failureReason: { type: String, default: null, maxlength: 64 },
    },
    pickupCodeHash: { type: String, default: null, maxlength: 64 },
    pickupCodeAttempts: { type: Number, required: true, default: 0, min: 0 },
    pickupWindow: {
      type: new Schema(
        { from: { type: Date, required: true }, to: { type: Date, required: true } },
        { _id: false },
      ),
      default: null,
    },
    acceptDeadline: { type: Date, default: null },
    autoCompleteAt: { type: Date, default: null },
    disputeDeadline: { type: Date, default: null },
    cancelledBy: { type: String, default: null, maxlength: 16 },
    cancelReasonCode: { type: String, enum: Object.values(CancelReasonCode), default: null },
    cancelReason: { type: String, default: null, maxlength: 500 },
    cancelPenalised: { type: Boolean, required: true, default: false },
    hasAdjustment: { type: Boolean, required: true, default: false },
    note: { type: String, default: null, maxlength: 500 },
    schemaVersion: { type: Number, required: true, default: 1 },
  },
  { timestamps: true, collection: 'orders', strict: 'throw', minimize: false },
);

orderSchema.index({ orderNo: 1 }, { unique: true });
// The seller queue: the hottest read and write path in the system (DATABASE.md 2.4).
orderSchema.index({ shopId: 1, status: 1, createdAt: -1 });
orderSchema.index({ buyerId: 1, createdAt: -1 });
orderSchema.index({ groupId: 1 });
orderSchema.index({ sellerId: 1, status: 1, createdAt: -1 });
orderSchema.index({ marketId: 1, createdAt: -1 });
// Sweeper cursors. Partial, so a one-minute cron scans a handful of rows rather than the
// whole collection — the difference between a cheap timer and the dominant load on the cluster.
orderSchema.index(
  { status: 1, acceptDeadline: 1 },
  { partialFilterExpression: { status: OrderStatus.PENDING } },
);
orderSchema.index(
  { status: 1, autoCompleteAt: 1 },
  { partialFilterExpression: { status: OrderStatus.PICKED_UP } },
);
orderSchema.index(
  { 'commission.status': 1, createdAt: 1 },
  { partialFilterExpression: { 'commission.status': CommissionStatus.PENDING } },
);

orderSchema.pre('validate', function enforceInvariants(next) {
  const itemsTotal = this.lines.reduce((sum, line) => sum + line.lineTotal, 0n);
  if (itemsTotal !== this.totals.items) {
    next(new Error('totals.items must equal the sum of the line totals'));
    return;
  }
  const grand =
    this.totals.items + this.totals.delivery - this.totals.discount;
  if (grand !== this.totals.grand) {
    next(new Error('totals.grand must equal items plus delivery minus discount'));
    return;
  }
  if (this.status === OrderStatus.CANCELLED && (!this.cancelledBy || !this.cancelReasonCode)) {
    next(new Error('A cancelled order must record who cancelled it and why'));
    return;
  }
  // Bounded: an order that ping-pongs between states cannot grow without limit; overflow is
  // preserved in the audit log instead (DATABASE.md 1.4).
  if (this.statusHistory.length > 50) {
    this.statusHistory = this.statusHistory.slice(-50);
  }
  next();
});

export const OrderModel: Model<OrderDoc> = model<OrderDoc>('Order', orderSchema);
