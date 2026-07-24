import { z } from 'zod';
import { ObjectIdSchema } from '../common/primitives.js';

export const ReviewStatusSchema = z.enum(['PUBLISHED', 'REPORTED', 'HIDDEN', 'WITHDRAWN']);
export const ReportReasonSchema = z.enum([
  'OFFENSIVE',
  'SPAM',
  'IRRELEVANT',
  'PERSONAL_DATA',
  'FAKE',
  'OTHER',
]);

/**
 * A review names the order it came from.
 *
 * There is no way to review a product without one — eligibility is proved by the order, not
 * asserted by the client, so the request has nowhere to claim it.
 */
export const CreateReviewRequestSchema = z
  .object({
    orderId: ObjectIdSchema,
    productId: ObjectIdSchema,
    rating: z.number().int().min(1).max(5),
    comment: z.string().trim().max(2000).optional(),
    photos: z.array(z.string().min(8).max(256)).max(5).optional(),
  })
  .strict();

export const ReplyToReviewRequestSchema = z
  .object({ text: z.string().trim().min(2).max(1000) })
  .strict();

export const ReportReviewRequestSchema = z
  .object({ reason: ReportReasonSchema, note: z.string().trim().max(500).optional() })
  .strict();

export const ModerateReviewRequestSchema = z
  .object({ hide: z.boolean(), reason: z.string().trim().min(5).max(500) })
  .strict();

export const ReviewResponseSchema = z.object({
  id: ObjectIdSchema,
  productId: ObjectIdSchema,
  rating: z.number().int().min(1).max(5),
  comment: z.string().nullable(),
  buyerName: z.string(),
  photos: z.array(z.object({ url: z.string(), blurhash: z.string().nullable() })),
  sellerReply: z.object({ text: z.string(), at: z.string().datetime() }).nullable(),
  createdAt: z.string().datetime(),
});

export const ReviewSummarySchema = z.object({
  average: z.number(),
  count: z.number().int(),
  distribution: z.record(z.number().int()),
});
