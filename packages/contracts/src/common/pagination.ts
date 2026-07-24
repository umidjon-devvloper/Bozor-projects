import { z } from 'zod';

/**
 * Cursor pagination only (API.md 1.6). Offset pagination degrades linearly and silently
 * skips or duplicates rows on a live collection.
 */
export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(2048).optional(),
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export const CursorMetaSchema = z.object({
  next: z.string().nullable(),
  hasMore: z.boolean(),
});

export const ResponseMetaSchema = z.object({
  requestId: z.string(),
  cursor: CursorMetaSchema.optional(),
  count: z.number().int().optional(),
  total: z.number().int().optional(),
  totalIsCapped: z.boolean().optional(),
});

export const envelope = <T extends z.ZodTypeAny>(data: T) =>
  z.object({ data, meta: ResponseMetaSchema });

export const collectionEnvelope = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ data: z.array(item), meta: ResponseMetaSchema });

export const FieldErrorSchema = z.object({
  field: z.string(),
  code: z.string(),
  params: z.record(z.unknown()).optional(),
});

/** RFC 9457 problem details plus a stable machine code (API.md 1.4). */
export const ProblemDetailsSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  requestId: z.string(),
  errors: z.array(FieldErrorSchema).optional(),
  params: z.record(z.unknown()).optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;
