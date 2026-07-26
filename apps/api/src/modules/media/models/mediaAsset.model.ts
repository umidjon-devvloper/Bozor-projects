import { MediaStatus } from '../media.constants.js';
import { Schema, model, type Model, type Types } from 'mongoose';
import { MediaPurpose, MediaVisibility } from '../media.constants.js';


export interface MediaVariantDoc {
  name: string;
  key: string;
  width: number;
  height: number;
  sizeBytes: number;
  contentType: string;
}

export interface MediaAssetDoc {
  _id: Types.ObjectId;
  /** Public identifier and the storage key. Randomised, never client-controlled. */
  mediaKey: string;
  ownerId: Types.ObjectId;
  purpose: MediaPurpose;
  visibility: MediaVisibility;
  bucket: string;
  declaredContentType: string;
  detectedContentType: string | null;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  blurhash: string | null;
  checksum: string | null;
  variants: MediaVariantDoc[];
  status: MediaStatus;
  rejectionReason: string | null;
  scanSignature: string | null;
  scannedAt: Date | null;
  confirmedAt: Date | null;
  attachedTo: { type: string; id: string } | null;
  attachedAt: Date | null;
  expiresAt: Date;
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const variantSchema = new Schema<MediaVariantDoc>(
  {
    name: { type: String, required: true, maxlength: 32 },
    key: { type: String, required: true, maxlength: 256 },
    width: { type: Number, required: true, min: 1 },
    height: { type: Number, required: true, min: 1 },
    sizeBytes: { type: Number, required: true, min: 0 },
    contentType: { type: String, required: true, maxlength: 64 },
  },
  { _id: false },
);

const mediaAssetSchema = new Schema<MediaAssetDoc>(
  {
    mediaKey: { type: String, required: true, maxlength: 256 },
    ownerId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    purpose: { type: String, enum: Object.values(MediaPurpose), required: true },
    visibility: { type: String, enum: Object.values(MediaVisibility), required: true },
    bucket: { type: String, required: true, maxlength: 64 },
    declaredContentType: { type: String, required: true, maxlength: 64 },
    detectedContentType: { type: String, default: null, maxlength: 64 },
    sizeBytes: { type: Number, required: true, min: 0 },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    blurhash: { type: String, default: null, maxlength: 64 },
    checksum: { type: String, default: null, maxlength: 128 },
    variants: {
      type: [variantSchema],
      default: [],
      validate: { validator: (v: unknown[]) => v.length <= 8, message: 'At most 8 variants' },
    },
    status: { type: String, enum: Object.values(MediaStatus), required: true, default: MediaStatus.PENDING },
    rejectionReason: { type: String, default: null, maxlength: 500 },
    scanSignature: { type: String, default: null, maxlength: 128 },
    scannedAt: { type: Date, default: null },
    confirmedAt: { type: Date, default: null },
    attachedTo: {
      type: new Schema(
        { type: { type: String, required: true, maxlength: 32 }, id: { type: String, required: true } },
        { _id: false },
      ),
      default: null,
    },
    attachedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
    schemaVersion: { type: Number, required: true, default: 1 },
  },
  { timestamps: true, collection: 'media_assets', strict: 'throw', minimize: false },
);

mediaAssetSchema.index({ mediaKey: 1 }, { unique: true });
mediaAssetSchema.index({ ownerId: 1, createdAt: -1 });
// Daily quota counting. Partial on non-rejected rows so a user cannot exhaust their quota
// with uploads that were refused.
mediaAssetSchema.index(
  { ownerId: 1, purpose: 1, createdAt: -1 },
  { partialFilterExpression: { status: { $ne: MediaStatus.REJECTED } } },
);
// Sweeper cursors: tiny partial indexes rather than a scan over every asset ever uploaded.
mediaAssetSchema.index(
  { status: 1, expiresAt: 1 },
  { partialFilterExpression: { status: MediaStatus.PENDING } },
);
mediaAssetSchema.index(
  { status: 1, confirmedAt: 1 },
  { partialFilterExpression: { status: MediaStatus.CONFIRMED } },
);
mediaAssetSchema.index({ 'attachedTo.type': 1, 'attachedTo.id': 1 });

export const MediaAssetModel: Model<MediaAssetDoc> = model<MediaAssetDoc>(
  'MediaAsset',
  mediaAssetSchema,
);
