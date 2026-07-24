import { Types, type ClientSession } from 'mongoose';
import type { LocalizedText } from '@bozorlar/types';
import {
  SellerApplicationModel,
  type ApplicationDocument,
  type ApplicationStatusChange,
  type SellerApplicationDoc,
} from '../models/sellerApplication.model.js';
import type { ApplicationStatus, RejectionReasonCode } from '../onboarding.constants.js';
import type { ParsedQuery } from '../../../http/query.js';

/**
 * Identity fields never leave this file in plaintext, and never leave it at all unless a
 * caller explicitly asks for the secret-bearing variant.
 */
export interface ApplicationRecord {
  id: string;
  userId: string;
  marketId: string;
  shopName: LocalizedText;
  contactPhone: string;
  documents: ApplicationDocument[];
  status: ApplicationStatus;
  statusHistory: ApplicationStatusChange[];
  submittedAt: Date | null;
  reviewerId: string | null;
  reviewedAt: Date | null;
  reviewSlaDueAt: Date | null;
  rejectionReasonCode: RejectionReasonCode | null;
  rejectionReason: string | null;
  resubmissionCount: number;
  approvedMarketId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApplicationSecrets {
  passportSeriesEncrypted: string;
  passportNumberEncrypted: string;
  passportBlindIndex: string;
  stirEncrypted: string;
  stirBlindIndex: string;
}

export interface CreateApplicationInput {
  userId: string;
  marketId: string;
  shopName: LocalizedText;
  contactPhone: string;
  documents: ApplicationDocument[];
  secrets: ApplicationSecrets;
  status: ApplicationStatus;
  submittedAt: Date | null;
  reviewSlaDueAt: Date | null;
}

function toRecord(doc: SellerApplicationDoc): ApplicationRecord {
  return {
    id: doc._id.toString(),
    userId: doc.userId.toString(),
    marketId: doc.marketId.toString(),
    shopName: doc.shopName,
    contactPhone: doc.contactPhone,
    documents: doc.documents,
    status: doc.status,
    statusHistory: doc.statusHistory,
    submittedAt: doc.submittedAt,
    reviewerId: doc.reviewerId?.toString() ?? null,
    reviewedAt: doc.reviewedAt,
    reviewSlaDueAt: doc.reviewSlaDueAt,
    rejectionReasonCode: doc.rejectionReasonCode,
    rejectionReason: doc.rejectionReason,
    resubmissionCount: doc.resubmissionCount,
    approvedMarketId: doc.approvedMarketId?.toString() ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

const SECRET_FIELDS =
  '+passportSeriesEncrypted +passportNumberEncrypted +passportBlindIndex +stirEncrypted +stirBlindIndex';

export const sellerApplicationRepository = {
  async create(input: CreateApplicationInput, session?: ClientSession): Promise<ApplicationRecord> {
    const [doc] = await SellerApplicationModel.create(
      [
        {
          userId: new Types.ObjectId(input.userId),
          marketId: new Types.ObjectId(input.marketId),
          shopName: input.shopName,
          contactPhone: input.contactPhone,
          documents: input.documents,
          status: input.status,
          submittedAt: input.submittedAt,
          reviewSlaDueAt: input.reviewSlaDueAt,
          ...input.secrets,
        },
      ],
      session ? { session } : {},
    );
    if (!doc) throw new Error('Application creation returned no document');
    return toRecord(doc.toObject<SellerApplicationDoc>());
  },

  async findById(id: string): Promise<ApplicationRecord | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const doc = await SellerApplicationModel.findById(id).lean<SellerApplicationDoc>();
    return doc ? toRecord(doc) : null;
  },

  /**
   * Loads the encrypted identity fields alongside the record.
   *
   * Separated from `findById` on purpose: reading identity documents is an auditable event,
   * and making it a distinct call means it cannot happen by accident in a list endpoint.
   */
  async findByIdWithSecrets(
    id: string,
  ): Promise<(ApplicationRecord & ApplicationSecrets) | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const doc = await SellerApplicationModel.findById(id)
      .select(SECRET_FIELDS)
      .lean<SellerApplicationDoc>();
    if (!doc) return null;
    return {
      ...toRecord(doc),
      passportSeriesEncrypted: doc.passportSeriesEncrypted,
      passportNumberEncrypted: doc.passportNumberEncrypted,
      passportBlindIndex: doc.passportBlindIndex,
      stirEncrypted: doc.stirEncrypted,
      stirBlindIndex: doc.stirBlindIndex,
    };
  },

  async findActiveForUser(userId: string): Promise<ApplicationRecord | null> {
    const doc = await SellerApplicationModel.findOne({
      userId,
      status: { $in: ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW'] },
    }).lean<SellerApplicationDoc>();
    return doc ? toRecord(doc) : null;
  },

  async findLatestForUser(userId: string): Promise<ApplicationRecord | null> {
    const doc = await SellerApplicationModel.findOne({ userId })
      .sort({ createdAt: -1 })
      .lean<SellerApplicationDoc>();
    return doc ? toRecord(doc) : null;
  },

  /**
   * Duplicate-identity probe.
   *
   * Matches on the blind index rather than the ciphertext, since two encryptions of the same
   * passport differ. Only approved applications are considered: a rejected or withdrawn
   * attempt must not lock a legitimate applicant out of their own document.
   */
  async findApprovedByIdentity(input: {
    passportBlindIndex: string;
    stirBlindIndex: string;
    excludeUserId?: string;
  }): Promise<{ id: string; userId: string; matchedOn: 'PASSPORT' | 'STIR' } | null> {
    const filter: Record<string, unknown> = {
      status: 'APPROVED',
      $or: [
        { passportBlindIndex: input.passportBlindIndex },
        { stirBlindIndex: input.stirBlindIndex },
      ],
    };
    if (input.excludeUserId) filter.userId = { $ne: new Types.ObjectId(input.excludeUserId) };

    const doc = await SellerApplicationModel.findOne(filter)
      .select(SECRET_FIELDS)
      .lean<SellerApplicationDoc>();
    if (!doc) return null;
    return {
      id: doc._id.toString(),
      userId: doc.userId.toString(),
      matchedOn: doc.passportBlindIndex === input.passportBlindIndex ? 'PASSPORT' : 'STIR',
    };
  },

  async list(parsed: ParsedQuery): Promise<ApplicationRecord[]> {
    const filter = parsed.cursorFilter
      ? { $and: [parsed.filter, parsed.cursorFilter] }
      : parsed.filter;
    const docs = await SellerApplicationModel.find(filter)
      .sort(parsed.sort)
      .limit(parsed.limit + 1)
      .lean<SellerApplicationDoc[]>();
    return docs.map(toRecord);
  },

  /**
   * Applies a state transition atomically.
   *
   * `expectedStatus` is part of the filter, which is what makes concurrent moderation safe:
   * two moderators approving the same application race, and exactly one update matches.
   */
  async transition(
    id: string,
    expectedStatus: ApplicationStatus,
    next: ApplicationStatus,
    patch: Record<string, unknown>,
    change: Omit<ApplicationStatusChange, 'at'>,
    session?: ClientSession,
  ): Promise<ApplicationRecord | null> {
    const doc = await SellerApplicationModel.findOneAndUpdate(
      { _id: id, status: expectedStatus },
      {
        $set: { ...patch, status: next },
        $push: { statusHistory: { ...change, at: new Date() } },
      },
      { new: true, runValidators: true, ...(session ? { session } : {}) },
    ).lean<SellerApplicationDoc>();
    return doc ? toRecord(doc) : null;
  },

  async replaceForResubmission(
    id: string,
    input: {
      marketId: string;
      shopName: LocalizedText;
      contactPhone: string;
      documents: ApplicationDocument[];
      secrets: ApplicationSecrets;
      reviewSlaDueAt: Date;
    },
    session?: ClientSession,
  ): Promise<ApplicationRecord | null> {
    const doc = await SellerApplicationModel.findOneAndUpdate(
      { _id: id, status: 'REJECTED' },
      {
        $set: {
          marketId: new Types.ObjectId(input.marketId),
          shopName: input.shopName,
          contactPhone: input.contactPhone,
          documents: input.documents,
          ...input.secrets,
          status: 'SUBMITTED',
          submittedAt: new Date(),
          reviewSlaDueAt: input.reviewSlaDueAt,
          reviewerId: null,
          reviewStartedAt: null,
          reviewedAt: null,
          rejectionReasonCode: null,
          rejectionReason: null,
        },
        $inc: { resubmissionCount: 1 },
        $push: {
          statusHistory: {
            from: 'REJECTED',
            to: 'SUBMITTED',
            at: new Date(),
            by: null,
            reasonCode: null,
            reason: 'Resubmitted by applicant',
          },
        },
      },
      { new: true, runValidators: true, ...(session ? { session } : {}) },
    ).lean<SellerApplicationDoc>();
    return doc ? toRecord(doc) : null;
  },

  async countByStatus(status: ApplicationStatus): Promise<number> {
    return SellerApplicationModel.countDocuments({ status });
  },
};
