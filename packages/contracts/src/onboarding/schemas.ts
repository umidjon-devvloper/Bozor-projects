import { z } from 'zod';
import { LocalizedTextSchema, ObjectIdSchema, PhoneSchema } from '../common/primitives.js';

export const ApplicationStatusSchema = z.enum([
  'DRAFT',
  'SUBMITTED',
  'UNDER_REVIEW',
  'APPROVED',
  'REJECTED',
  'WITHDRAWN',
]);

export const DocumentTypeSchema = z.enum([
  'PASSPORT',
  'STIR_CERTIFICATE',
  'MARKET_CONTRACT',
  'SHOP_PHOTO',
]);

export const RejectionReasonCodeSchema = z.enum([
  'DOCUMENT_UNREADABLE',
  'DOCUMENT_MISMATCH',
  'IDENTITY_UNVERIFIED',
  'STIR_INVALID',
  'CONTRACT_INVALID',
  'DUPLICATE_APPLICANT',
  'PROHIBITED_GOODS',
  'OTHER',
]);

const ApplicationDocumentSchema = z
  .object({ type: DocumentTypeSchema, mediaKey: z.string().min(8).max(256) })
  .strict();

/**
 * Identity fields are write-only across the whole API surface.
 *
 * They appear in this request schema and in no response schema anywhere. A moderator reads
 * them through a separate, audited reveal endpoint rather than as a field on the application.
 */
export const SubmitApplicationRequestSchema = z
  .object({
    marketId: ObjectIdSchema,
    shopName: LocalizedTextSchema,
    contactPhone: PhoneSchema,
    passportSeries: z.string().trim().min(2).max(4),
    passportNumber: z.string().trim().min(7).max(9),
    stir: z.string().trim().min(9).max(11),
    documents: z.array(ApplicationDocumentSchema).min(1).max(10),
  })
  .strict();

export const RejectApplicationRequestSchema = z
  .object({
    reasonCode: RejectionReasonCodeSchema,
    // A moderator's rejection has to be actionable by the applicant, so free text is
    // required in addition to the code and cannot be a single character.
    reason: z.string().trim().min(10).max(1000),
  })
  .strict();

export const ApplicationResponseSchema = z.object({
  id: ObjectIdSchema,
  marketId: ObjectIdSchema,
  shopName: z.union([z.string(), LocalizedTextSchema]),
  contactPhone: z.string(),
  documents: z.array(
    z.object({ type: DocumentTypeSchema, mediaKey: z.string(), uploadedAt: z.string().datetime() }),
  ),
  status: ApplicationStatusSchema,
  submittedAt: z.string().datetime().nullable(),
  reviewedAt: z.string().datetime().nullable(),
  rejectionReasonCode: RejectionReasonCodeSchema.nullable(),
  rejectionReason: z.string().nullable(),
  resubmissionCount: z.number().int(),
  resubmissionsRemaining: z.number().int(),
  approvedMarketId: ObjectIdSchema.nullable(),
  createdAt: z.string().datetime(),
});

/** Returned only by the audited reveal endpoint, only to a moderator. */
export const RevealedIdentityResponseSchema = z.object({
  passportSeries: z.string(),
  passportNumber: z.string(),
  stir: z.string(),
});
