import { Schema, model, type Model, type Types } from 'mongoose';
import { DisputeOutcome, DisputeStatus } from '@bozorlar/domain';
import {
  DisputeReason,
  MAX_EVIDENCE_PHOTOS,
  MAX_MESSAGE_LENGTH,
  SettlementMethod,
} from '../disputes.constants.js';

export interface DisputeEvidence {
  mediaKey: string;
  blurhash: string | null;
  uploadedBy: Types.ObjectId;
  uploadedAt: Date;
}

export interface DisputeMessage {
  authorId: Types.ObjectId;
  authorRole: 'BUYER' | 'SELLER' | 'MODERATOR';
  text: string;
  at: Date;
}

/**
 * A disputed order.
 *
 * Holds the whole case: what the buyer claimed, what the seller answered, what evidence each
 * produced, and what a named moderator decided and why. The financial consequences live in
 * the ledger and on the order; this is the record of the reasoning, which is the part that has
 * to survive being asked about years later.
 */
export interface DisputeDoc {
  _id: Types.ObjectId;
  disputeNo: string;
  orderId: Types.ObjectId;
  orderNo: string;
  buyerId: Types.ObjectId;
  sellerId: Types.ObjectId;
  shopId: Types.ObjectId;
  reason: DisputeReason;
  claim: string;
  /** What the buyer says they are owed. The moderator is not bound by it. */
  claimedAmountMinor: bigint | null;
  orderTotalMinor: bigint;
  evidence: DisputeEvidence[];
  messages: DisputeMessage[];
  status: DisputeStatus;
  sellerRespondedAt: Date | null;
  sellerResponseDeadline: Date;
  assignedTo: Types.ObjectId | null;
  resolution: {
    outcome: DisputeOutcome;
    refundAmountMinor: bigint;
    commissionReversedMinor: bigint;
    settlementMethod: SettlementMethod;
    reason: string;
    decidedBy: Types.ObjectId;
    decidedAt: Date;
  } | null;
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const evidenceSchema = new Schema<DisputeEvidence>(
  {
    mediaKey: { type: String, required: true, maxlength: 256 },
    blurhash: { type: String, default: null, maxlength: 64 },
    uploadedBy: { type: Schema.Types.ObjectId, required: true },
    uploadedAt: { type: Date, required: true, default: () => new Date() },
  },
  { _id: false },
);

const messageSchema = new Schema<DisputeMessage>(
  {
    authorId: { type: Schema.Types.ObjectId, required: true },
    authorRole: { type: String, enum: ['BUYER', 'SELLER', 'MODERATOR'], required: true },
    text: { type: String, required: true, maxlength: MAX_MESSAGE_LENGTH },
    at: { type: Date, required: true, default: () => new Date() },
  },
  { _id: false },
);

const disputeSchema = new Schema<DisputeDoc>(
  {
    disputeNo: { type: String, required: true, maxlength: 32 },
    orderId: { type: Schema.Types.ObjectId, required: true, ref: 'Order' },
    orderNo: { type: String, required: true, maxlength: 32 },
    buyerId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    sellerId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    shopId: { type: Schema.Types.ObjectId, required: true, ref: 'Shop' },
    reason: { type: String, enum: Object.values(DisputeReason), required: true },
    claim: { type: String, required: true, minlength: 10, maxlength: MAX_MESSAGE_LENGTH },
    claimedAmountMinor: { type: BigInt, default: null },
    orderTotalMinor: { type: BigInt, required: true },
    evidence: {
      type: [evidenceSchema],
      default: [],
      validate: {
        validator: (v: DisputeEvidence[]) => v.length <= MAX_EVIDENCE_PHOTOS * 2,
        message: 'Too much evidence attached',
      },
    },
    messages: { type: [messageSchema], default: [] },
    status: {
      type: String,
      enum: Object.values(DisputeStatus),
      required: true,
      default: DisputeStatus.OPEN,
    },
    sellerRespondedAt: { type: Date, default: null },
    sellerResponseDeadline: { type: Date, required: true },
    assignedTo: { type: Schema.Types.ObjectId, default: null },
    resolution: {
      type: new Schema(
        {
          outcome: { type: String, enum: Object.values(DisputeOutcome), required: true },
          refundAmountMinor: { type: BigInt, required: true },
          commissionReversedMinor: { type: BigInt, required: true },
          settlementMethod: { type: String, enum: Object.values(SettlementMethod), required: true },
          reason: { type: String, required: true, minlength: 10, maxlength: 1000 },
          decidedBy: { type: Schema.Types.ObjectId, required: true },
          decidedAt: { type: Date, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
    schemaVersion: { type: Number, required: true, default: 1 },
  },
  { timestamps: true, collection: 'disputes', strict: 'throw', minimize: false },
);

disputeSchema.index({ disputeNo: 1 }, { unique: true });
// One live dispute per order. A settled one must not block a second, genuinely different claim.
disputeSchema.index(
  { orderId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: [DisputeStatus.OPEN, DisputeStatus.UNDER_REVIEW] } },
  },
);
disputeSchema.index({ buyerId: 1, createdAt: -1 });
disputeSchema.index({ shopId: 1, createdAt: -1 });
// The arbitration queue, oldest first, kept small by a partial index.
disputeSchema.index(
  { status: 1, createdAt: 1 },
  { partialFilterExpression: { status: { $in: [DisputeStatus.OPEN, DisputeStatus.UNDER_REVIEW] } } },
);
// The sweeper that moves an ignored dispute along without the seller.
disputeSchema.index(
  { status: 1, sellerResponseDeadline: 1 },
  { partialFilterExpression: { status: DisputeStatus.OPEN } },
);
disputeSchema.index({ assignedTo: 1, status: 1 });

disputeSchema.pre('validate', function enforceInvariants(next) {
  if (this.resolution) {
    if (this.resolution.refundAmountMinor > this.orderTotalMinor) {
      next(new Error('A refund cannot exceed the order total'));
      return;
    }
    if (this.resolution.refundAmountMinor < 0n || this.resolution.commissionReversedMinor < 0n) {
      next(new Error('Resolution amounts cannot be negative'));
      return;
    }
    if (
      this.resolution.outcome === DisputeOutcome.NO_REFUND &&
      this.resolution.refundAmountMinor !== 0n
    ) {
      next(new Error('A dismissed dispute cannot award a refund'));
      return;
    }
  }
  if (this.claimedAmountMinor !== null && this.claimedAmountMinor > this.orderTotalMinor) {
    next(new Error('A claim cannot exceed the order total'));
    return;
  }
  if (this.messages.length > 100) this.messages = this.messages.slice(-100);
  next();
});

export const DisputeModel: Model<DisputeDoc> = model<DisputeDoc>('Dispute', disputeSchema);
