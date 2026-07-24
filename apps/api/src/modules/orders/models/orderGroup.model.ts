import { Schema, model, type Model, type Types } from 'mongoose';
import { GroupStatus } from '@bozorlar/domain';

/**
 * The buyer-facing basket (ADR-0007).
 *
 * A cart spanning three stalls becomes one group and three orders, because acceptance,
 * pickup, cancellation and commission are all per seller. `derivedStatus` is a projection
 * for list rendering; no business rule reads it, and cancelling one child never cascades.
 */
export interface OrderGroupDoc {
  _id: Types.ObjectId;
  groupNo: string;
  buyerId: Types.ObjectId;
  orderIds: Types.ObjectId[];
  quoteId: string;
  paymentMode: 'CASH_ON_PICKUP' | 'PREPAID_ONLINE';
  paymentId: Types.ObjectId | null;
  totals: { items: bigint; discount: bigint; delivery: bigint; grand: bigint };
  derivedStatus: GroupStatus;
  buyerSnapshot: { name: string; phone: string };
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const orderGroupSchema = new Schema<OrderGroupDoc>(
  {
    groupNo: { type: String, required: true, maxlength: 32 },
    buyerId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    orderIds: {
      type: [Schema.Types.ObjectId],
      required: true,
      validate: {
        validator: (v: unknown[]) => v.length >= 1 && v.length <= 20,
        message: 'A group must contain between 1 and 20 orders',
      },
    },
    quoteId: { type: String, required: true, maxlength: 64 },
    paymentMode: { type: String, enum: ['CASH_ON_PICKUP', 'PREPAID_ONLINE'], required: true },
    paymentId: { type: Schema.Types.ObjectId, default: null },
    totals: {
      items: { type: BigInt, required: true },
      discount: { type: BigInt, required: true, default: 0n },
      delivery: { type: BigInt, required: true, default: 0n },
      grand: { type: BigInt, required: true },
    },
    derivedStatus: {
      type: String,
      enum: Object.values(GroupStatus),
      required: true,
      default: GroupStatus.ACTIVE,
    },
    buyerSnapshot: {
      name: { type: String, required: true, maxlength: 120 },
      phone: { type: String, required: true, maxlength: 20 },
    },
    schemaVersion: { type: Number, required: true, default: 1 },
  },
  { timestamps: true, collection: 'order_groups', strict: 'throw', minimize: false },
);

orderGroupSchema.index({ groupNo: 1 }, { unique: true });
orderGroupSchema.index({ buyerId: 1, createdAt: -1 });
// One group per quote: the quote's CONSUMED status is the primary guard, this is the backstop.
orderGroupSchema.index({ quoteId: 1 }, { unique: true });
orderGroupSchema.index({ derivedStatus: 1, createdAt: -1 });

export const OrderGroupModel: Model<OrderGroupDoc> = model<OrderGroupDoc>(
  'OrderGroup',
  orderGroupSchema,
);
