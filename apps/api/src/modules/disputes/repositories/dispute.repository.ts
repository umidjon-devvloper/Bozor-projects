import { Types, type ClientSession } from 'mongoose';
import { Money } from '@bozorlar/money';
import { DisputeOutcome, DisputeStatus } from '@bozorlar/domain';
import {
  DisputeModel,
  type DisputeDoc,
  type DisputeEvidence,
  type DisputeMessage,
} from '../models/dispute.model.js';
import type { DisputeReason, SettlementMethod } from '../disputes.constants.js';
import type { ParsedQuery } from '../../../http/query.js';

export interface DisputeRecord {
  id: string;
  disputeNo: string;
  orderId: string;
  orderNo: string;
  buyerId: string;
  sellerId: string;
  shopId: string;
  reason: DisputeReason;
  claim: string;
  claimedAmount: Money | null;
  orderTotal: Money;
  evidence: DisputeEvidence[];
  messages: DisputeMessage[];
  status: DisputeStatus;
  sellerRespondedAt: Date | null;
  sellerResponseDeadline: Date;
  assignedTo: string | null;
  resolution: {
    outcome: DisputeOutcome;
    refundAmount: Money;
    commissionReversed: Money;
    settlementMethod: SettlementMethod;
    reason: string;
    decidedAt: Date;
  } | null;
  createdAt: Date;
}

function toRecord(doc: DisputeDoc): DisputeRecord {
  return {
    id: doc._id.toString(),
    disputeNo: doc.disputeNo,
    orderId: doc.orderId.toString(),
    orderNo: doc.orderNo,
    buyerId: doc.buyerId.toString(),
    sellerId: doc.sellerId.toString(),
    shopId: doc.shopId.toString(),
    reason: doc.reason,
    claim: doc.claim,
    claimedAmount: doc.claimedAmountMinor === null ? null : Money.of(doc.claimedAmountMinor),
    orderTotal: Money.of(doc.orderTotalMinor),
    evidence: doc.evidence,
    messages: doc.messages,
    status: doc.status,
    sellerRespondedAt: doc.sellerRespondedAt,
    sellerResponseDeadline: doc.sellerResponseDeadline,
    assignedTo: doc.assignedTo?.toString() ?? null,
    resolution: doc.resolution
      ? {
          outcome: doc.resolution.outcome,
          refundAmount: Money.of(doc.resolution.refundAmountMinor),
          commissionReversed: Money.of(doc.resolution.commissionReversedMinor),
          settlementMethod: doc.resolution.settlementMethod,
          reason: doc.resolution.reason,
          decidedAt: doc.resolution.decidedAt,
        }
      : null,
    createdAt: doc.createdAt,
  };
}

export const disputeRepository = {
  async create(
    input: {
      disputeNo: string;
      orderId: string;
      orderNo: string;
      buyerId: string;
      sellerId: string;
      shopId: string;
      reason: DisputeReason;
      claim: string;
      claimedAmountMinor: bigint | null;
      orderTotalMinor: bigint;
      evidence: DisputeEvidence[];
      sellerResponseDeadline: Date;
    },
    session: ClientSession,
  ): Promise<DisputeRecord> {
    const [doc] = await DisputeModel.create(
      [
        {
          ...input,
          orderId: new Types.ObjectId(input.orderId),
          buyerId: new Types.ObjectId(input.buyerId),
          sellerId: new Types.ObjectId(input.sellerId),
          shopId: new Types.ObjectId(input.shopId),
        },
      ],
      { session },
    );
    if (!doc) throw new Error('Dispute creation returned no document');
    return toRecord(doc.toObject<DisputeDoc>());
  },

  async findById(id: string): Promise<DisputeRecord | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const doc = await DisputeModel.findById(id).lean<DisputeDoc>();
    return doc ? toRecord(doc) : null;
  },

  async findOpenForOrder(orderId: string): Promise<DisputeRecord | null> {
    const doc = await DisputeModel.findOne({
      orderId: new Types.ObjectId(orderId),
      status: { $in: [DisputeStatus.OPEN, DisputeStatus.UNDER_REVIEW] },
    }).lean<DisputeDoc>();
    return doc ? toRecord(doc) : null;
  },

  async list(parsed: ParsedQuery, extra: Record<string, unknown>): Promise<DisputeRecord[]> {
    const base = { ...parsed.filter, ...extra };
    const filter = parsed.cursorFilter ? { $and: [base, parsed.cursorFilter] } : base;
    const docs = await DisputeModel.find(filter)
      .sort(parsed.sort)
      .limit(parsed.limit + 1)
      .lean<DisputeDoc[]>();
    return docs.map(toRecord);
  },

  async addMessage(
    disputeId: string,
    message: { authorId: string; authorRole: 'BUYER' | 'SELLER' | 'MODERATOR'; text: string },
    evidence: DisputeEvidence[],
  ): Promise<DisputeRecord | null> {
    const doc = await DisputeModel.findOneAndUpdate(
      { _id: disputeId, status: { $in: [DisputeStatus.OPEN, DisputeStatus.UNDER_REVIEW] } },
      {
        $push: {
          messages: {
            $each: [
              {
                authorId: new Types.ObjectId(message.authorId),
                authorRole: message.authorRole,
                text: message.text,
                at: new Date(),
              },
            ],
            $slice: -100,
          },
          ...(evidence.length > 0 ? { evidence: { $each: evidence } } : {}),
        },
      },
      { new: true, runValidators: true },
    ).lean<DisputeDoc>();
    return doc ? toRecord(doc) : null;
  },

  /**
   * Applies a status change, guarded by the status it expects to find.
   *
   * Two moderators resolving the same case at the same moment produce exactly one winner, and
   * the loser is told the case moved rather than overwriting a decision that has already had
   * financial consequences.
   */
  async transition(
    disputeId: string,
    expected: DisputeStatus[],
    next: DisputeStatus,
    patch: Record<string, unknown>,
    session: ClientSession,
  ): Promise<DisputeRecord | null> {
    const doc = await DisputeModel.findOneAndUpdate(
      { _id: disputeId, status: { $in: expected } },
      { $set: { ...patch, status: next } },
      { new: true, runValidators: true, session },
    ).lean<DisputeDoc>();
    return doc ? toRecord(doc) : null;
  },

  async findResponseOverdue(limit: number, now: Date): Promise<DisputeRecord[]> {
    const docs = await DisputeModel.find({
      status: DisputeStatus.OPEN,
      sellerResponseDeadline: { $lte: now },
    })
      .limit(limit)
      .lean<DisputeDoc[]>();
    return docs.map(toRecord);
  },

  async countOpenForShop(shopId: string): Promise<number> {
    return DisputeModel.countDocuments({
      shopId: new Types.ObjectId(shopId),
      status: { $in: [DisputeStatus.OPEN, DisputeStatus.UNDER_REVIEW] },
    });
  },
};
