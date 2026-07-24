import { Types, type ClientSession } from 'mongoose';
import { ReviewModel, type ReviewDoc, type ReviewPhoto } from '../models/review.model.js';
import { COUNTED_STATUSES, ReportReason, ReviewStatus } from '../reviews.constants.js';
import type { ParsedQuery } from '../../../http/query.js';

export interface ReviewRecord {
  id: string;
  orderId: string;
  orderNo: string;
  productId: string;
  shopId: string;
  buyerId: string;
  buyerName: string;
  rating: number;
  comment: string | null;
  photos: ReviewPhoto[];
  status: ReviewStatus;
  sellerReply: { text: string; at: Date } | null;
  reportCount: number;
  createdAt: Date;
}

function toRecord(doc: ReviewDoc): ReviewRecord {
  return {
    id: doc._id.toString(),
    orderId: doc.orderId.toString(),
    orderNo: doc.orderNo,
    productId: doc.productId.toString(),
    shopId: doc.shopId.toString(),
    buyerId: doc.buyerId.toString(),
    buyerName: doc.buyerName,
    rating: doc.rating,
    comment: doc.comment,
    photos: doc.photos,
    status: doc.status,
    sellerReply: doc.sellerReply ? { text: doc.sellerReply.text, at: doc.sellerReply.at } : null,
    reportCount: doc.reports.length,
    createdAt: doc.createdAt,
  };
}

export const reviewRepository = {
  async create(
    input: {
      orderId: string;
      orderNo: string;
      productId: string;
      shopId: string;
      buyerId: string;
      buyerName: string;
      rating: number;
      comment: string | null;
      photos: ReviewPhoto[];
    },
    session: ClientSession,
  ): Promise<ReviewRecord> {
    const [doc] = await ReviewModel.create(
      [
        {
          ...input,
          orderId: new Types.ObjectId(input.orderId),
          productId: new Types.ObjectId(input.productId),
          shopId: new Types.ObjectId(input.shopId),
          buyerId: new Types.ObjectId(input.buyerId),
        },
      ],
      { session },
    );
    if (!doc) throw new Error('Review creation returned no document');
    return toRecord(doc.toObject<ReviewDoc>());
  },

  async findById(id: string): Promise<ReviewRecord | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const doc = await ReviewModel.findById(id).lean<ReviewDoc>();
    return doc ? toRecord(doc) : null;
  },

  async existsForOrderLine(orderId: string, productId: string): Promise<boolean> {
    return (
      (await ReviewModel.countDocuments({
        orderId: new Types.ObjectId(orderId),
        productId: new Types.ObjectId(productId),
      }).limit(1)) > 0
    );
  },

  async list(parsed: ParsedQuery, extra: Record<string, unknown>): Promise<ReviewRecord[]> {
    const base = { ...parsed.filter, ...extra };
    const filter = parsed.cursorFilter ? { $and: [base, parsed.cursorFilter] } : base;
    const docs = await ReviewModel.find(filter)
      .sort(parsed.sort)
      .limit(parsed.limit + 1)
      .lean<ReviewDoc[]>();
    return docs.map(toRecord);
  },

  /** The star histogram a product page shows beside its average. */
  async distribution(target: { field: 'productId' | 'shopId'; id: string }): Promise<Record<number, number>> {
    const rows = await ReviewModel.aggregate<{ _id: number; count: number }>([
      {
        $match: {
          [target.field]: new Types.ObjectId(target.id),
          status: { $in: COUNTED_STATUSES },
        },
      },
      { $group: { _id: '$rating', count: { $sum: 1 } } },
    ]);
    const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const row of rows) distribution[row._id] = row.count;
    return distribution;
  },

  /**
   * Records a seller's answer, once.
   *
   * The `sellerReply: null` guard makes a second attempt a no-op rather than an overwrite: a
   * reply a buyer has already read should not be silently replaced.
   */
  async addSellerReply(
    reviewId: string,
    reply: { text: string; by: string },
  ): Promise<ReviewRecord | null> {
    const doc = await ReviewModel.findOneAndUpdate(
      { _id: reviewId, sellerReply: null },
      { $set: { sellerReply: { text: reply.text, at: new Date(), by: new Types.ObjectId(reply.by) } } },
      { new: true, runValidators: true },
    ).lean<ReviewDoc>();
    return doc ? toRecord(doc) : null;
  },

  /**
   * Adds a report, ignoring a repeat from the same person.
   *
   * The `$ne` on the reporter is what stops one determined account manufacturing a moderation
   * queue entry by clicking five times.
   */
  async addReport(
    reviewId: string,
    report: { userId: string; reason: ReportReason; note: string | null },
  ): Promise<{ record: ReviewRecord; added: boolean } | null> {
    const doc = await ReviewModel.findOneAndUpdate(
      { _id: reviewId, 'reports.userId': { $ne: new Types.ObjectId(report.userId) } },
      {
        $push: {
          reports: {
            userId: new Types.ObjectId(report.userId),
            reason: report.reason,
            note: report.note,
            at: new Date(),
          },
        },
      },
      { new: true },
    ).lean<ReviewDoc>();

    if (doc) return { record: toRecord(doc), added: true };
    const existing = await ReviewModel.findById(reviewId).lean<ReviewDoc>();
    return existing ? { record: toRecord(existing), added: false } : null;
  },

  async setStatus(
    reviewId: string,
    expected: ReviewStatus[],
    next: ReviewStatus,
    patch: Record<string, unknown>,
    session: ClientSession,
  ): Promise<ReviewRecord | null> {
    const doc = await ReviewModel.findOneAndUpdate(
      { _id: reviewId, status: { $in: expected } },
      { $set: { ...patch, status: next } },
      { new: true, runValidators: true, session },
    ).lean<ReviewDoc>();
    return doc ? toRecord(doc) : null;
  },

  async countForShopAwaitingReply(shopId: string): Promise<number> {
    return ReviewModel.countDocuments({
      shopId: new Types.ObjectId(shopId),
      sellerReply: null,
      status: ReviewStatus.PUBLISHED,
    });
  },
};
