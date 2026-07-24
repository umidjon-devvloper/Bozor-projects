import type { OtpPurpose } from '@bozorlar/types';
import { OtpCodeModel, type OtpCodeDoc } from '../models/otpCode.model.js';

export interface OtpRecord {
  id: string;
  identifier: string;
  purpose: OtpPurpose;
  codeHash: string;
  attempts: number;
  sentCount: number;
  consumedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

function toRecord(doc: OtpCodeDoc): OtpRecord {
  return {
    id: doc._id.toString(),
    identifier: doc.identifier,
    purpose: doc.purpose,
    codeHash: doc.codeHash,
    attempts: doc.attempts,
    sentCount: doc.sentCount,
    consumedAt: doc.consumedAt,
    expiresAt: doc.expiresAt,
    createdAt: doc.createdAt,
  };
}

export const otpRepository = {
  async create(input: {
    identifier: string;
    purpose: OtpPurpose;
    codeHash: string;
    expiresAt: Date;
    ip?: string | null;
  }): Promise<OtpRecord> {
    const doc = await OtpCodeModel.create({
      identifier: input.identifier,
      purpose: input.purpose,
      codeHash: input.codeHash,
      expiresAt: input.expiresAt,
      ip: input.ip ?? null,
    });
    return toRecord(doc.toObject<OtpCodeDoc>());
  },

  async findActive(identifier: string, purpose: OtpPurpose): Promise<OtpRecord | null> {
    const doc = await OtpCodeModel.findOne({ identifier, purpose, consumedAt: null })
      .select('+codeHash')
      .sort({ createdAt: -1 })
      .lean<OtpCodeDoc>();
    return doc ? toRecord(doc) : null;
  },

  async countSentSince(identifier: string, since: Date): Promise<number> {
    return OtpCodeModel.countDocuments({ identifier, createdAt: { $gte: since } });
  },

  async incrementAttempts(id: string): Promise<number> {
    const doc = await OtpCodeModel.findOneAndUpdate(
      { _id: id },
      { $inc: { attempts: 1 } },
      { new: true, projection: { attempts: 1 } },
    ).lean<Pick<OtpCodeDoc, 'attempts'>>();
    return doc?.attempts ?? 0;
  },

  /** Atomic single-use consume: a replayed code cannot verify twice. */
  async consume(id: string): Promise<boolean> {
    const result = await OtpCodeModel.updateOne(
      { _id: id, consumedAt: null },
      { $set: { consumedAt: new Date() } },
    );
    return result.modifiedCount === 1;
  },

  async invalidateAll(identifier: string, purpose: OtpPurpose): Promise<void> {
    await OtpCodeModel.updateMany(
      { identifier, purpose, consumedAt: null },
      { $set: { consumedAt: new Date() } },
    );
  },
};
