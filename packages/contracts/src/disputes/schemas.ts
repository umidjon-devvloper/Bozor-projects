import { z } from 'zod';
import { ObjectIdSchema } from '../common/primitives.js';

const MinorUnitString = z.string().regex(/^\d{1,19}$/, 'Must be an integer string of minor units');

export const DisputeStatusSchema = z.enum([
  'OPEN',
  'UNDER_REVIEW',
  'RESOLVED_BUYER',
  'RESOLVED_SELLER',
  'WITHDRAWN',
]);

export const DisputeReasonSchema = z.enum([
  'NOT_RECEIVED',
  'WRONG_ITEM',
  'SHORT_WEIGHT',
  'POOR_QUALITY',
  'SPOILED',
  'OVERCHARGED',
  'OTHER',
]);

export const DisputeOutcomeSchema = z.enum(['REFUND_FULL', 'REFUND_PARTIAL', 'NO_REFUND']);

/**
 * Raising a dispute names the order and states a case.
 *
 * `claim` has a real minimum length: a dispute is read by a moderator who has to decide
 * between two people, and "bad" is not something anyone can arbitrate.
 */
export const RaiseDisputeRequestSchema = z
  .object({
    orderId: ObjectIdSchema,
    reason: DisputeReasonSchema,
    claim: z.string().trim().min(10).max(2000),
    claimedAmount: MinorUnitString.optional(),
    evidence: z.array(z.string().min(8).max(256)).max(8).optional(),
  })
  .strict();

export const DisputeMessageRequestSchema = z
  .object({
    text: z.string().trim().min(2).max(2000),
    evidence: z.array(z.string().min(8).max(256)).max(8).optional(),
  })
  .strict();

export const ResolveDisputeRequestSchema = z
  .object({
    outcome: DisputeOutcomeSchema,
    refundAmount: MinorUnitString.optional(),
    // The reason is shown to both parties and kept for years; one word is not a decision.
    reason: z.string().trim().min(10).max(1000),
  })
  .strict()
  .refine((value) => value.outcome !== 'REFUND_PARTIAL' || value.refundAmount !== undefined, {
    message: 'A partial refund needs an amount',
    path: ['refundAmount'],
  })
  .refine((value) => value.outcome !== 'NO_REFUND' || value.refundAmount === undefined, {
    message: 'A dismissed dispute cannot carry a refund amount',
    path: ['refundAmount'],
  });

export const DisputeResponseSchema = z.object({
  id: ObjectIdSchema,
  disputeNo: z.string(),
  orderNo: z.string(),
  reason: DisputeReasonSchema,
  claim: z.string(),
  status: DisputeStatusSchema,
  messages: z.array(
    z.object({
      authorRole: z.enum(['BUYER', 'SELLER', 'MODERATOR']),
      text: z.string(),
      at: z.string().datetime(),
    }),
  ),
  resolution: z
    .object({
      outcome: DisputeOutcomeSchema,
      refundAmount: z.object({ amount: z.string(), currency: z.literal('UZS') }),
      settlementMethod: z.enum(['SELLER_DIRECT', 'PAYMENT_GATEWAY']),
      reason: z.string(),
      decidedAt: z.string().datetime(),
    })
    .nullable(),
  createdAt: z.string().datetime(),
});
