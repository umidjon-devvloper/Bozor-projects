import { z } from 'zod';

/**
 * Report queries.
 *
 * The window is optional and defaults to the last thirty days, because the commonest question
 * is "how are we doing" and making somebody type two dates to ask it is friction for no gain.
 * The bound on how long a window may be lives in the service, not here: it is a policy about
 * what the database can afford, not about what a client is allowed to say.
 */
export const ReportPeriodQuerySchema = z
  .object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .strict();

export const SellerReportQuerySchema = ReportPeriodQuerySchema.extend({
  page: z.coerce.number().int().min(0).max(200).default(0),
}).strict();

export const StatementQuerySchema = ReportPeriodQuerySchema.extend({
  /** Admin only. A seller's statement is always their own and needs no target. */
  shopId: z
    .string()
    .regex(/^[a-f0-9]{24}$/)
    .optional(),
}).strict();

export type ReportPeriodQuery = z.infer<typeof ReportPeriodQuerySchema>;
export type SellerReportQuery = z.infer<typeof SellerReportQuerySchema>;
export type StatementQuery = z.infer<typeof StatementQuerySchema>;
