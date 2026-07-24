import { Types, type ClientSession } from 'mongoose';
import {
  MediaAssetModel,
  MediaStatus,
  type MediaAssetDoc,
  type MediaVariantDoc,
} from '../models/mediaAsset.model.js';
import type { MediaPurpose, MediaVisibility } from '../media.constants.js';

export interface MediaAssetRecord {
  id: string;
  mediaKey: string;
  ownerId: string;
  purpose: MediaPurpose;
  visibility: MediaVisibility;
  bucket: string;
  declaredContentType: string;
  detectedContentType: string | null;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  blurhash: string | null;
  variants: MediaVariantDoc[];
  status: MediaStatus;
  attachedTo: { type: string; id: string } | null;
  confirmedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

function toRecord(doc: MediaAssetDoc): MediaAssetRecord {
  return {
    id: doc._id.toString(),
    mediaKey: doc.mediaKey,
    ownerId: doc.ownerId.toString(),
    purpose: doc.purpose,
    visibility: doc.visibility,
    bucket: doc.bucket,
    declaredContentType: doc.declaredContentType,
    detectedContentType: doc.detectedContentType,
    sizeBytes: doc.sizeBytes,
    width: doc.width,
    height: doc.height,
    blurhash: doc.blurhash,
    variants: doc.variants,
    status: doc.status,
    attachedTo: doc.attachedTo,
    confirmedAt: doc.confirmedAt,
    expiresAt: doc.expiresAt,
    createdAt: doc.createdAt,
  };
}

export const mediaAssetRepository = {
  async create(input: {
    mediaKey: string;
    ownerId: string;
    purpose: MediaPurpose;
    visibility: MediaVisibility;
    bucket: string;
    declaredContentType: string;
    sizeBytes: number;
    expiresAt: Date;
  }): Promise<MediaAssetRecord> {
    const doc = await MediaAssetModel.create({
      ...input,
      ownerId: new Types.ObjectId(input.ownerId),
    });
    return toRecord(doc.toObject<MediaAssetDoc>());
  },

  async findByKey(mediaKey: string): Promise<MediaAssetRecord | null> {
    const doc = await MediaAssetModel.findOne({ mediaKey }).lean<MediaAssetDoc>();
    return doc ? toRecord(doc) : null;
  },

  async findManyByKeys(mediaKeys: readonly string[]): Promise<MediaAssetRecord[]> {
    if (mediaKeys.length === 0) return [];
    const docs = await MediaAssetModel.find({ mediaKey: { $in: mediaKeys } }).lean<MediaAssetDoc[]>();
    return docs.map(toRecord);
  },

  /**
   * Counts uploads by this user, for this purpose, since a cutoff. Rejected assets are
   * excluded by the partial index, so a caller cannot burn their quota on refused files.
   */
  async countRecent(ownerId: string, purpose: MediaPurpose, since: Date): Promise<number> {
    return MediaAssetModel.countDocuments({
      ownerId,
      purpose,
      createdAt: { $gte: since },
      status: { $ne: MediaStatus.REJECTED },
    });
  },

  /**
   * Marks an asset confirmed, but only from PENDING.
   *
   * The status guard in the filter is what makes a duplicated confirm request harmless: the
   * second call matches nothing and the caller is told the asset is already confirmed,
   * instead of the object being processed and re-uploaded twice.
   */
  async confirm(
    mediaKey: string,
    input: {
      bucket: string;
      detectedContentType: string;
      sizeBytes: number;
      width: number | null;
      height: number | null;
      blurhash: string | null;
      checksum: string;
      variants: MediaVariantDoc[];
      expiresAt: Date;
    },
  ): Promise<MediaAssetRecord | null> {
    const doc = await MediaAssetModel.findOneAndUpdate(
      { mediaKey, status: MediaStatus.PENDING },
      {
        $set: {
          ...input,
          status: MediaStatus.CONFIRMED,
          confirmedAt: new Date(),
          scannedAt: new Date(),
        },
      },
      { new: true },
    ).lean<MediaAssetDoc>();
    return doc ? toRecord(doc) : null;
  },

  async reject(mediaKey: string, reason: string, signature: string | null): Promise<void> {
    await MediaAssetModel.updateOne(
      { mediaKey },
      {
        $set: {
          status: MediaStatus.REJECTED,
          rejectionReason: reason,
          scanSignature: signature,
          scannedAt: new Date(),
        },
      },
    );
  },

  /**
   * Attaches assets to an owning entity.
   *
   * Takes a session because attachment happens inside the transaction that creates the
   * entity referencing it. An entity that commits while its images stay unattached would
   * have them swept out from under it within the day.
   */
  async attach(
    mediaKeys: readonly string[],
    target: { type: string; id: string },
    session: ClientSession,
  ): Promise<number> {
    if (mediaKeys.length === 0) return 0;
    const result = await MediaAssetModel.updateMany(
      { mediaKey: { $in: mediaKeys }, status: MediaStatus.CONFIRMED },
      { $set: { status: MediaStatus.ATTACHED, attachedTo: target, attachedAt: new Date() } },
      { session },
    );
    return result.modifiedCount;
  },

  async detachAllFor(
    target: { type: string; id: string },
    session: ClientSession,
  ): Promise<number> {
    const result = await MediaAssetModel.updateMany(
      { 'attachedTo.type': target.type, 'attachedTo.id': target.id },
      {
        $set: {
          status: MediaStatus.CONFIRMED,
          attachedTo: null,
          attachedAt: null,
          // Detached assets re-enter the sweep window rather than lingering forever.
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      },
      { session },
    );
    return result.modifiedCount;
  },

  async delete(mediaKey: string): Promise<boolean> {
    const result = await MediaAssetModel.deleteOne({ mediaKey });
    return result.deletedCount === 1;
  },

  async listExpiredPending(limit: number, now: Date): Promise<MediaAssetRecord[]> {
    const docs = await MediaAssetModel.find({ status: MediaStatus.PENDING, expiresAt: { $lte: now } })
      .limit(limit)
      .lean<MediaAssetDoc[]>();
    return docs.map(toRecord);
  },

  async listUnattachedConfirmed(limit: number, before: Date): Promise<MediaAssetRecord[]> {
    const docs = await MediaAssetModel.find({
      status: MediaStatus.CONFIRMED,
      confirmedAt: { $lte: before },
    })
      .limit(limit)
      .lean<MediaAssetDoc[]>();
    return docs.map(toRecord);
  },

  async markOrphaned(mediaKeys: readonly string[]): Promise<number> {
    if (mediaKeys.length === 0) return 0;
    const result = await MediaAssetModel.updateMany(
      { mediaKey: { $in: mediaKeys } },
      { $set: { status: MediaStatus.ORPHANED } },
    );
    return result.modifiedCount;
  },
};
