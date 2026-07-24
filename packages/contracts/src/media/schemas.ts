import { z } from 'zod';

/**
 * Media contracts.
 *
 * The purpose enum is duplicated here rather than imported from the API module because
 * `packages/contracts` must not depend on an app (ADR-0011). The values are asserted to match
 * by a unit test in the API, so drift is a failing build rather than a runtime surprise.
 */
export const MediaPurposeSchema = z.enum([
  'PRODUCT_IMAGE',
  'SHOP_LOGO',
  'SHOP_COVER',
  'SHOP_PHOTO',
  'MARKET_PHOTO',
  'AVATAR',
  'REVIEW_PHOTO',
  'KYC_DOCUMENT',
  'DISPUTE_EVIDENCE',
]);
export type MediaPurposeValue = z.infer<typeof MediaPurposeSchema>;

/** Storage keys are server-generated; this only guards the shape of what is echoed back. */
export const MediaKeySchema = z
  .string()
  .min(8)
  .max(256)
  .regex(/^[a-z_]+\/\d{4}-\d{2}-\d{2}\/[a-f\d]{24}\/[a-f\d]{32}\.[a-z0-9]{2,4}$/i, 'Invalid media key');

export const CreateUploadUrlRequestSchema = z
  .object({
    purpose: MediaPurposeSchema,
    contentType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
    sizeBytes: z.number().int().positive().max(20 * 1024 * 1024),
  })
  .strict();

export const UploadTicketResponseSchema = z.object({
  mediaKey: z.string(),
  uploadUrl: z.string().url(),
  expiresAt: z.string().datetime(),
  maxSizeBytes: z.number().int(),
  requiredContentType: z.string(),
  requiredContentLength: z.number().int(),
});

export const ConfirmUploadRequestSchema = z.object({ mediaKey: MediaKeySchema }).strict();

export const MediaVariantResponseSchema = z.object({
  name: z.string(),
  url: z.string(),
  width: z.number().int(),
  height: z.number().int(),
});

export const ConfirmedAssetResponseSchema = z.object({
  mediaKey: z.string(),
  url: z.string().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  blurhash: z.string().nullable(),
  sizeBytes: z.number().int(),
  variants: z.array(MediaVariantResponseSchema),
});

export const DownloadUrlResponseSchema = z.object({
  url: z.string().url(),
  expiresAt: z.string().datetime(),
});
