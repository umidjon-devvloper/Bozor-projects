import { Types, type ClientSession } from 'mongoose';
import type { TokenRevokeReason } from '@bozorlar/types';
import { RefreshTokenModel, type RefreshTokenDoc } from '../models/refreshToken.model.js';

export interface RefreshTokenRecord {
  id: string;
  userId: string;
  familyId: string;
  deviceId: string;
  usedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
}

function toRecord(doc: RefreshTokenDoc): RefreshTokenRecord {
  return {
    id: doc._id.toString(),
    userId: doc.userId.toString(),
    familyId: doc.familyId.toString(),
    deviceId: doc.deviceId,
    usedAt: doc.usedAt,
    revokedAt: doc.revokedAt,
    expiresAt: doc.expiresAt,
    ip: doc.ip,
    userAgent: doc.userAgent,
    createdAt: doc.createdAt,
  };
}

export const refreshTokenRepository = {
  async create(
    input: {
      userId: string;
      familyId?: string;
      tokenHash: string;
      deviceId: string;
      parentId?: string;
      ip?: string | null;
      userAgent?: string | null;
      expiresAt: Date;
    },
    session?: ClientSession,
  ): Promise<RefreshTokenRecord> {
    const [doc] = await RefreshTokenModel.create(
      [
        {
          userId: new Types.ObjectId(input.userId),
          familyId: input.familyId ? new Types.ObjectId(input.familyId) : new Types.ObjectId(),
          tokenHash: input.tokenHash,
          deviceId: input.deviceId,
          parentId: input.parentId ? new Types.ObjectId(input.parentId) : null,
          ip: input.ip ?? null,
          userAgent: input.userAgent ?? null,
          expiresAt: input.expiresAt,
        },
      ],
      session ? { session } : {},
    );
    if (!doc) throw new Error('Refresh token creation returned no document');
    return toRecord(doc.toObject<RefreshTokenDoc>());
  },

  async findByHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    const doc = await RefreshTokenModel.findOne({ tokenHash }).lean<RefreshTokenDoc>();
    return doc ? toRecord(doc) : null;
  },

  /**
   * Atomic consume. The filter includes `usedAt: null`, so two concurrent refreshes with the
   * same token cannot both succeed — the loser gets null and is treated as reuse.
   */
  async consume(id: string, session?: ClientSession): Promise<boolean> {
    const result = await RefreshTokenModel.updateOne(
      { _id: id, usedAt: null, revokedAt: null },
      { $set: { usedAt: new Date() } },
      session ? { session } : {},
    );
    return result.modifiedCount === 1;
  },

  async revokeFamily(
    familyId: string,
    reason: TokenRevokeReason,
    session?: ClientSession,
  ): Promise<number> {
    const result = await RefreshTokenModel.updateMany(
      { familyId, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: reason } },
      session ? { session } : {},
    );
    return result.modifiedCount;
  },

  async revokeAllForUser(userId: string, reason: TokenRevokeReason): Promise<number> {
    const result = await RefreshTokenModel.updateMany(
      { userId, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: reason } },
    );
    return result.modifiedCount;
  },

  async revokeById(id: string, userId: string, reason: TokenRevokeReason): Promise<boolean> {
    const result = await RefreshTokenModel.updateOne(
      { _id: id, userId, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: reason } },
    );
    return result.modifiedCount === 1;
  },

  async listActiveSessions(userId: string): Promise<RefreshTokenRecord[]> {
    const docs = await RefreshTokenModel.find({
      userId,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean<RefreshTokenDoc[]>();
    return docs.map(toRecord);
  },

  async isFamilyRevoked(familyId: string): Promise<boolean> {
    return (await RefreshTokenModel.countDocuments({ familyId, revokedAt: { $ne: null } }).limit(1)) > 0;
  },
};
