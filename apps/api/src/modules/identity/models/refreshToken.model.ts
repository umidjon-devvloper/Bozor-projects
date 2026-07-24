import { Schema, model, type Model, type Types } from 'mongoose';
import { TokenRevokeReason } from '@bozorlar/types';

export interface RefreshTokenDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  /** Rotation chain. Reuse of any consumed member revokes the entire family (ADR-0013). */
  familyId: Types.ObjectId;
  tokenHash: string;
  deviceId: string;
  parentId: Types.ObjectId | null;
  usedAt: Date | null;
  revokedAt: Date | null;
  revokedReason: TokenRevokeReason | null;
  ip: string | null;
  userAgent: string | null;
  expiresAt: Date;
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const refreshTokenSchema = new Schema<RefreshTokenDoc>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    familyId: { type: Schema.Types.ObjectId, required: true },
    // Only the hash is stored. A database dump must not yield usable sessions (AUTH.md).
    tokenHash: { type: String, required: true },
    deviceId: { type: String, required: true },
    parentId: { type: Schema.Types.ObjectId, default: null },
    usedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, enum: Object.values(TokenRevokeReason), default: null },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null, maxlength: 512 },
    expiresAt: { type: Date, required: true },
    schemaVersion: { type: Number, required: true, default: 1 },
  },
  { timestamps: true, collection: 'refresh_tokens', strict: 'throw' },
);

refreshTokenSchema.index({ tokenHash: 1 }, { unique: true });
refreshTokenSchema.index({ userId: 1, revokedAt: 1 });
refreshTokenSchema.index({ familyId: 1 });
// TTL is cleanup, never revocation: the sweep can lag by up to a minute, so revokedAt is
// always checked on use (DATABASE.md 2.1).
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RefreshTokenModel: Model<RefreshTokenDoc> = model<RefreshTokenDoc>(
  'RefreshToken',
  refreshTokenSchema,
);
