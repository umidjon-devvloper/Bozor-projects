import { Schema, model, type Model, type Types } from 'mongoose';
import { ConsentType } from '@bozorlar/types';

/**
 * Append-only. A revocation is a new document, never an update: the history of what a user
 * agreed to, and when, is the entire point (COMPLIANCE.md).
 */
export interface UserConsentDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  type: ConsentType;
  documentVersion: string;
  granted: boolean;
  grantedAt: Date;
  ip: string | null;
  userAgent: string | null;
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const userConsentSchema = new Schema<UserConsentDoc>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    type: { type: String, enum: Object.values(ConsentType), required: true },
    documentVersion: { type: String, required: true, maxlength: 32 },
    granted: { type: Boolean, required: true },
    grantedAt: { type: Date, required: true, default: () => new Date() },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null, maxlength: 512 },
    schemaVersion: { type: Number, required: true, default: 1 },
  },
  { timestamps: true, collection: 'user_consents', strict: 'throw' },
);

userConsentSchema.index({ userId: 1, type: 1, grantedAt: -1 });
userConsentSchema.index({ type: 1, documentVersion: 1 });

userConsentSchema.pre('updateOne', function blockMutation(next) {
  next(new Error('user_consents is append-only; record a new consent instead of updating'));
});

export const UserConsentModel: Model<UserConsentDoc> = model<UserConsentDoc>(
  'UserConsent',
  userConsentSchema,
);
