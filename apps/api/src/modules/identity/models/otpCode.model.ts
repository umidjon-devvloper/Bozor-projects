import { Schema, model, type Model, type Types } from 'mongoose';
import { OtpPurpose } from '@bozorlar/types';

export interface OtpCodeDoc {
  _id: Types.ObjectId;
  identifier: string;
  purpose: OtpPurpose;
  codeHash: string;
  attempts: number;
  sentCount: number;
  consumedAt: Date | null;
  expiresAt: Date;
  ip: string | null;
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const otpCodeSchema = new Schema<OtpCodeDoc>(
  {
    identifier: { type: String, required: true, trim: true },
    purpose: { type: String, enum: Object.values(OtpPurpose), required: true },
    // Hashed: a plaintext OTP table in a backup is a complete account-takeover kit.
    codeHash: { type: String, required: true, select: false },
    attempts: { type: Number, required: true, default: 0, min: 0 },
    sentCount: { type: Number, required: true, default: 1, min: 1 },
    consumedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
    ip: { type: String, default: null },
    schemaVersion: { type: Number, required: true, default: 1 },
  },
  { timestamps: true, collection: 'otp_codes', strict: 'throw' },
);

otpCodeSchema.index({ identifier: 1, purpose: 1, consumedAt: 1 });
otpCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const OtpCodeModel: Model<OtpCodeDoc> = model<OtpCodeDoc>('OtpCode', otpCodeSchema);
