/**
 * Moved here from the model file during the boundary cleanup. A status vocabulary is a module
 * constant that the schema happens to validate against — not part of the persistence layer —
 * and living beside the schema meant every service reading it had to import a model file.
 */
export const MediaStatus = {
  /** Presigned URL issued; the object may or may not exist yet. */
  PENDING: 'PENDING',
  /** Verified, scanned, processed, and moved to its final bucket. */
  CONFIRMED: 'CONFIRMED',
  /** Referenced by a shop, product, review or application. */
  ATTACHED: 'ATTACHED',
  /** Never confirmed or never attached; swept from storage. */
  ORPHANED: 'ORPHANED',
  /** Rejected by validation or the scanner. Kept as a record; bytes removed. */
  REJECTED: 'REJECTED',
} as const;
export type MediaStatus = (typeof MediaStatus)[keyof typeof MediaStatus];

/**
 * Upload purpose policies.
 *
 * Every constraint that matters — where a file lands, who may read it, how large it may be,
 * which formats are permitted, whether derivatives are generated — is declared here rather
 * than scattered across handlers. Adding a new upload purpose is one table entry, and it is
 * impossible to add one without deciding its bucket and size cap.
 */
export const MediaPurpose = {
  PRODUCT_IMAGE: 'PRODUCT_IMAGE',
  SHOP_LOGO: 'SHOP_LOGO',
  SHOP_COVER: 'SHOP_COVER',
  SHOP_PHOTO: 'SHOP_PHOTO',
  MARKET_PHOTO: 'MARKET_PHOTO',
  AVATAR: 'AVATAR',
  REVIEW_PHOTO: 'REVIEW_PHOTO',
  KYC_DOCUMENT: 'KYC_DOCUMENT',
  DISPUTE_EVIDENCE: 'DISPUTE_EVIDENCE',
} as const;
export type MediaPurpose = (typeof MediaPurpose)[keyof typeof MediaPurpose];

export const MediaVisibility = {
  /** Served from the CDN, cacheable, no credentials. */
  PUBLIC: 'PUBLIC',
  /** Private bucket. Reachable only through short-lived signed URLs, and every issue is audited. */
  PRIVATE: 'PRIVATE',
} as const;
export type MediaVisibility = (typeof MediaVisibility)[keyof typeof MediaVisibility];

export interface VariantSpec {
  name: string;
  width: number;
  height: number;
  fit: 'cover' | 'inside';
}

export interface PurposePolicy {
  visibility: MediaVisibility;
  maxSizeBytes: number;
  allowedMimeTypes: readonly string[];
  /** Empty for documents: a PDF is stored as received, never re-encoded. */
  variants: readonly VariantSpec[];
  /** Images are re-encoded, which is what strips EXIF (including GPS). */
  reencode: boolean;
  dailyQuota: number;
}

const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;

const IMAGE_VARIANTS: readonly VariantSpec[] = [
  { name: 'thumb', width: 200, height: 200, fit: 'cover' },
  { name: 'card', width: 600, height: 600, fit: 'inside' },
  { name: 'full', width: 1600, height: 1600, fit: 'inside' },
];

export const PURPOSE_POLICIES: Readonly<Record<MediaPurpose, PurposePolicy>> = {
  PRODUCT_IMAGE: {
    visibility: MediaVisibility.PUBLIC,
    maxSizeBytes: 10 * 1024 * 1024,
    allowedMimeTypes: IMAGE_MIME,
    variants: IMAGE_VARIANTS,
    reencode: true,
    dailyQuota: 300,
  },
  SHOP_LOGO: {
    visibility: MediaVisibility.PUBLIC,
    maxSizeBytes: 5 * 1024 * 1024,
    allowedMimeTypes: IMAGE_MIME,
    variants: [
      { name: 'thumb', width: 128, height: 128, fit: 'cover' },
      { name: 'card', width: 400, height: 400, fit: 'cover' },
    ],
    reencode: true,
    dailyQuota: 20,
  },
  SHOP_COVER: {
    visibility: MediaVisibility.PUBLIC,
    maxSizeBytes: 8 * 1024 * 1024,
    allowedMimeTypes: IMAGE_MIME,
    variants: [
      { name: 'card', width: 800, height: 400, fit: 'cover' },
      { name: 'full', width: 1600, height: 800, fit: 'cover' },
    ],
    reencode: true,
    dailyQuota: 20,
  },
  SHOP_PHOTO: {
    visibility: MediaVisibility.PUBLIC,
    maxSizeBytes: 8 * 1024 * 1024,
    allowedMimeTypes: IMAGE_MIME,
    variants: IMAGE_VARIANTS,
    reencode: true,
    dailyQuota: 50,
  },
  MARKET_PHOTO: {
    visibility: MediaVisibility.PUBLIC,
    maxSizeBytes: 10 * 1024 * 1024,
    allowedMimeTypes: IMAGE_MIME,
    variants: IMAGE_VARIANTS,
    reencode: true,
    dailyQuota: 50,
  },
  AVATAR: {
    visibility: MediaVisibility.PUBLIC,
    maxSizeBytes: 3 * 1024 * 1024,
    allowedMimeTypes: IMAGE_MIME,
    variants: [{ name: 'thumb', width: 200, height: 200, fit: 'cover' }],
    reencode: true,
    dailyQuota: 10,
  },
  REVIEW_PHOTO: {
    visibility: MediaVisibility.PUBLIC,
    maxSizeBytes: 8 * 1024 * 1024,
    allowedMimeTypes: IMAGE_MIME,
    variants: [
      { name: 'thumb', width: 200, height: 200, fit: 'cover' },
      { name: 'card', width: 800, height: 800, fit: 'inside' },
    ],
    reencode: true,
    dailyQuota: 30,
  },
  KYC_DOCUMENT: {
    visibility: MediaVisibility.PRIVATE,
    maxSizeBytes: 20 * 1024 * 1024,
    allowedMimeTypes: [...IMAGE_MIME, 'application/pdf'],
    // No derivatives and no re-encoding: a KYC document is evidence, and a moderator must
    // see exactly what was submitted, not a recompressed approximation of it.
    variants: [],
    reencode: false,
    dailyQuota: 20,
  },
  DISPUTE_EVIDENCE: {
    visibility: MediaVisibility.PRIVATE,
    maxSizeBytes: 15 * 1024 * 1024,
    allowedMimeTypes: [...IMAGE_MIME, 'application/pdf'],
    variants: [],
    reencode: false,
    dailyQuota: 30,
  },
};

/** How long a presigned PUT stays valid. Long enough for a slow mobile upload, no longer. */
export const UPLOAD_URL_TTL_SECONDS = 15 * 60;

/** Signed read URL lifetime for private objects. Deliberately short. */
export const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

/** An asset that is uploaded but never attached to anything is swept after this. */
export const UNATTACHED_TTL_HOURS = 24;
