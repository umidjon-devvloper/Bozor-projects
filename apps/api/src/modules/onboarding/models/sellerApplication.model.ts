import { Schema, model, type Model, type Types } from 'mongoose';
import type { LocalizedText } from '@bozorlar/types';
import {
  ApplicationStatus,
  DocumentType,
  MAX_DOCUMENTS,
  RejectionReasonCode,
} from '../onboarding.constants.js';

export interface ApplicationDocument {
  type: DocumentType;
  mediaKey: string;
  uploadedAt: Date;
}

export interface ApplicationStatusChange {
  from: ApplicationStatus;
  to: ApplicationStatus;
  at: Date;
  by: Types.ObjectId | null;
  reasonCode: RejectionReasonCode | null;
  reason: string | null;
}

export interface SellerApplicationDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  marketId: Types.ObjectId;
  shopName: LocalizedText;
  contactPhone: string;
  /** AES-256-GCM envelopes. Never projected by default, never logged, never returned. */
  passportSeriesEncrypted: string;
  passportNumberEncrypted: string;
  /** Keyed HMAC of series+number. Uniquely indexed to detect the same document reused. */
  passportBlindIndex: string;
  stirEncrypted: string;
  stirBlindIndex: string;
  documents: ApplicationDocument[];
  status: ApplicationStatus;
  statusHistory: ApplicationStatusChange[];
  submittedAt: Date | null;
  reviewerId: Types.ObjectId | null;
  reviewStartedAt: Date | null;
  reviewedAt: Date | null;
  reviewSlaDueAt: Date | null;
  rejectionReasonCode: RejectionReasonCode | null;
  rejectionReason: string | null;
  resubmissionCount: number;
  /** Set on approval. The market the seller is authorised to open a shop in. */
  approvedMarketId: Types.ObjectId | null;
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const localizedText = {
  uz: { type: String, required: true, trim: true, maxlength: 200 },
  uzCyrl: { type: String, trim: true, maxlength: 200 },
  ru: { type: String, trim: true, maxlength: 200 },
  en: { type: String, trim: true, maxlength: 200 },
};

const documentSchema = new Schema<ApplicationDocument>(
  {
    type: { type: String, enum: Object.values(DocumentType), required: true },
    mediaKey: { type: String, required: true, maxlength: 256 },
    uploadedAt: { type: Date, required: true, default: () => new Date() },
  },
  { _id: false },
);

const statusChangeSchema = new Schema<ApplicationStatusChange>(
  {
    from: { type: String, enum: Object.values(ApplicationStatus), required: true },
    to: { type: String, enum: Object.values(ApplicationStatus), required: true },
    at: { type: Date, required: true, default: () => new Date() },
    by: { type: Schema.Types.ObjectId, default: null },
    reasonCode: { type: String, enum: Object.values(RejectionReasonCode), default: null },
    reason: { type: String, default: null, maxlength: 1000 },
  },
  { _id: false },
);

const sellerApplicationSchema = new Schema<SellerApplicationDoc>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    marketId: { type: Schema.Types.ObjectId, required: true, ref: 'Market' },
    shopName: { type: localizedText, required: true },
    contactPhone: { type: String, required: true, match: /^\+998\d{9}$/ },

    // select: false on every identity field. A future endpoint that forgets to exclude them
    // gets nothing rather than a passport number.
    passportSeriesEncrypted: { type: String, required: true, select: false },
    passportNumberEncrypted: { type: String, required: true, select: false },
    passportBlindIndex: { type: String, required: true, select: false },
    stirEncrypted: { type: String, required: true, select: false },
    stirBlindIndex: { type: String, required: true, select: false },

    documents: {
      type: [documentSchema],
      default: [],
      validate: {
        validator: (v: ApplicationDocument[]) => v.length <= MAX_DOCUMENTS,
        message: `At most ${MAX_DOCUMENTS} documents`,
      },
    },
    status: {
      type: String,
      enum: Object.values(ApplicationStatus),
      required: true,
      default: ApplicationStatus.DRAFT,
    },
    statusHistory: { type: [statusChangeSchema], default: [] },
    submittedAt: { type: Date, default: null },
    reviewerId: { type: Schema.Types.ObjectId, default: null, ref: 'User' },
    reviewStartedAt: { type: Date, default: null },
    reviewedAt: { type: Date, default: null },
    reviewSlaDueAt: { type: Date, default: null },
    rejectionReasonCode: { type: String, enum: Object.values(RejectionReasonCode), default: null },
    rejectionReason: { type: String, default: null, maxlength: 1000 },
    resubmissionCount: { type: Number, required: true, default: 0, min: 0 },
    approvedMarketId: { type: Schema.Types.ObjectId, default: null },
    schemaVersion: { type: Number, required: true, default: 1 },
  },
  { timestamps: true, collection: 'seller_applications', strict: 'throw', minimize: false },
);

// One live application per user. Partial so a withdrawn or rejected attempt does not block
// a genuine second try, while two concurrent submissions cannot both exist.
sellerApplicationSchema.index(
  { userId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: {
        $in: [ApplicationStatus.DRAFT, ApplicationStatus.SUBMITTED, ApplicationStatus.UNDER_REVIEW],
      },
    },
  },
);
// The duplicate-identity control: the same passport cannot be approved for two accounts.
sellerApplicationSchema.index(
  { passportBlindIndex: 1 },
  { unique: true, partialFilterExpression: { status: ApplicationStatus.APPROVED } },
);
sellerApplicationSchema.index(
  { stirBlindIndex: 1 },
  { unique: true, partialFilterExpression: { status: ApplicationStatus.APPROVED } },
);
// Moderation queue, ESR-ordered and partial so it stays small.
sellerApplicationSchema.index(
  { status: 1, submittedAt: 1 },
  {
    partialFilterExpression: {
      status: { $in: [ApplicationStatus.SUBMITTED, ApplicationStatus.UNDER_REVIEW] },
    },
  },
);
sellerApplicationSchema.index({ userId: 1, createdAt: -1 });
sellerApplicationSchema.index({ marketId: 1, status: 1 });
sellerApplicationSchema.index({ reviewerId: 1, reviewedAt: -1 });

sellerApplicationSchema.pre('validate', function enforceInvariants(next) {
  if (this.status === ApplicationStatus.REJECTED && !this.rejectionReasonCode) {
    next(new Error('rejectionReasonCode is required when an application is REJECTED'));
    return;
  }
  if (this.status === ApplicationStatus.APPROVED && !this.approvedMarketId) {
    next(new Error('approvedMarketId is required when an application is APPROVED'));
    return;
  }
  // statusHistory is bounded: an application that ping-pongs cannot grow without limit.
  if (this.statusHistory.length > 50) {
    this.statusHistory = this.statusHistory.slice(-50);
  }
  next();
});

export const SellerApplicationModel: Model<SellerApplicationDoc> = model<SellerApplicationDoc>(
  'SellerApplication',
  sellerApplicationSchema,
);
