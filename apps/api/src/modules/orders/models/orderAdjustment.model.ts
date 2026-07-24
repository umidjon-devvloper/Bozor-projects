import { Schema, model, type Model, type Types } from 'mongoose';
import { AdjustmentStatus } from '../orders.constants.js';

/**
 * A weight correction at handover (ADR-0006).
 *
 * Kept as its own collection rather than only on the line, so the negotiation survives
 * independently of the order: a seller who systematically over-delivers is visible here as a
 * pattern, which is what the abuse report reads.
 */
export interface OrderAdjustmentDoc {
  _id: Types.ObjectId;
  orderId: Types.ObjectId;
  orderNo: string;
  shopId: Types.ObjectId;
  buyerId: Types.ObjectId;
  lines: Array<{
    lineId: string;
    orderedQtyMilli: bigint;
    proposedQtyMilli: bigint;
    deltaBp: number;
    oldLineTotal: bigint;
    newLineTotal: bigint;
  }>;
  oldTotal: bigint;
  newTotal: bigint;
  status: AdjustmentStatus;
  requestedBy: Types.ObjectId;
  respondedAt: Date | null;
  expiresAt: Date;
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const adjustmentLineSchema = new Schema(
  {
    lineId: { type: String, required: true, maxlength: 32 },
    orderedQtyMilli: { type: BigInt, required: true },
    proposedQtyMilli: { type: BigInt, required: true },
    deltaBp: { type: Number, required: true },
    oldLineTotal: { type: BigInt, required: true },
    newLineTotal: { type: BigInt, required: true },
  },
  { _id: false },
);

const adjustmentSchema = new Schema<OrderAdjustmentDoc>(
  {
    orderId: { type: Schema.Types.ObjectId, required: true, ref: 'Order' },
    orderNo: { type: String, required: true, maxlength: 32 },
    shopId: { type: Schema.Types.ObjectId, required: true },
    buyerId: { type: Schema.Types.ObjectId, required: true },
    lines: { type: [adjustmentLineSchema], required: true },
    oldTotal: { type: BigInt, required: true },
    newTotal: { type: BigInt, required: true },
    status: {
      type: String,
      enum: Object.values(AdjustmentStatus),
      required: true,
      default: AdjustmentStatus.PENDING,
    },
    requestedBy: { type: Schema.Types.ObjectId, required: true },
    respondedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
    schemaVersion: { type: Number, required: true, default: 1 },
  },
  { timestamps: true, collection: 'order_adjustments', strict: 'throw' },
);

adjustmentSchema.index({ orderId: 1, createdAt: -1 });
adjustmentSchema.index(
  { status: 1, expiresAt: 1 },
  { partialFilterExpression: { status: AdjustmentStatus.PENDING } },
);
// The over-delivery abuse report reads this.
adjustmentSchema.index({ shopId: 1, createdAt: -1 });

export const OrderAdjustmentModel: Model<OrderAdjustmentDoc> = model<OrderAdjustmentDoc>(
  'OrderAdjustment',
  adjustmentSchema,
);
