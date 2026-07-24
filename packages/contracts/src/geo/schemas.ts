import { z } from 'zod';
import { MarketStatus, ModerationStatus, ShopMemberRole } from '@bozorlar/types';
import { LocalizedTextSchema, ObjectIdSchema, PhoneSchema } from '../common/primitives.js';

const TimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm');

export const WorkingHoursEntrySchema = z
  .object({
    weekday: z.number().int().min(0).max(6),
    opensAt: TimeSchema,
    closesAt: TimeSchema,
    isClosed: z.boolean(),
  })
  .strict();

export const WorkingHoursSchema = z
  .array(WorkingHoursEntrySchema)
  .length(7, 'Exactly one entry per weekday is required')
  .refine((entries) => new Set(entries.map((e) => e.weekday)).size === 7, {
    message: 'Each weekday must appear exactly once',
  });

export const CoordinatesSchema = z
  .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })
  .strict();

/** Query params arrive as strings, so coercion happens here rather than in handlers. */
export const NearbyQuerySchema = z
  .object({
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
    radius: z.coerce.number().int().min(100).max(50_000).default(5_000),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

export const CreateMarketRequestSchema = z
  .object({
    districtId: ObjectIdSchema,
    name: LocalizedTextSchema,
    address: LocalizedTextSchema,
    description: LocalizedTextSchema.optional(),
    location: CoordinatesSchema,
    workingHours: WorkingHoursSchema,
    timezone: z.string().min(3).max(64).optional(),
    contactPhone: PhoneSchema.optional(),
    sections: z
      .array(z.object({ code: z.string().min(1).max(16), name: LocalizedTextSchema }).strict())
      .max(100)
      .optional(),
  })
  .strict();

export const UpdateMarketRequestSchema = z
  .object({
    name: LocalizedTextSchema.optional(),
    address: LocalizedTextSchema.optional(),
    description: LocalizedTextSchema.optional(),
    contactPhone: PhoneSchema.optional(),
    workingHours: WorkingHoursSchema.optional(),
    timezone: z.string().min(3).max(64).optional(),
    sections: z
      .array(z.object({ code: z.string().min(1).max(16), name: LocalizedTextSchema }).strict())
      .max(100)
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'At least one field is required' });

export const SetMarketStatusRequestSchema = z
  .object({
    status: z.nativeEnum(MarketStatus),
    reason: z.string().min(3).max(500),
  })
  .strict();

export const CreateShopRequestSchema = z
  .object({
    marketId: ObjectIdSchema,
    name: LocalizedTextSchema,
    description: LocalizedTextSchema.optional(),
    contactPhone: PhoneSchema,
    sectionCode: z.string().min(1).max(16).optional(),
    stallNo: z.string().min(1).max(16).optional(),
    categoryIds: z.array(ObjectIdSchema).max(10).optional(),
    workingHours: WorkingHoursSchema.optional(),
    location: CoordinatesSchema.optional(),
  })
  .strict();

export const UpdateShopRequestSchema = z
  .object({
    name: LocalizedTextSchema.optional(),
    description: LocalizedTextSchema.optional(),
    contactPhone: PhoneSchema.optional(),
    sectionCode: z.string().min(1).max(16).optional(),
    stallNo: z.string().min(1).max(16).optional(),
    categoryIds: z.array(ObjectIdSchema).max(10).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'At least one field is required' });

export const SetShopWorkingHoursRequestSchema = z
  .object({ workingHours: WorkingHoursSchema, timezone: z.string().min(3).max(64).optional() })
  .strict();

export const SetShopVacationRequestSchema = z
  .object({ until: z.string().datetime().nullable() })
  .strict();

export const AddShopMemberRequestSchema = z
  .object({
    phone: PhoneSchema,
    role: z.enum([ShopMemberRole.MANAGER, ShopMemberRole.STAFF]),
  })
  .strict();

export const ModerateShopRequestSchema = z
  .object({ approved: z.boolean(), reason: z.string().min(3).max(1000).optional() })
  .strict()
  .refine((value) => value.approved || value.reason !== undefined, {
    message: 'A reason is required when rejecting',
    path: ['reason'],
  });

export const RegionResponseSchema = z.object({
  id: ObjectIdSchema,
  code: z.string(),
  name: z.union([z.string(), LocalizedTextSchema]),
  center: CoordinatesSchema,
  districtCount: z.number().int(),
});

export const MarketResponseSchema = z.object({
  id: ObjectIdSchema,
  slug: z.string(),
  name: z.union([z.string(), LocalizedTextSchema]),
  description: z.union([z.string(), LocalizedTextSchema]).nullable(),
  address: z.union([z.string(), LocalizedTextSchema]),
  location: CoordinatesSchema,
  distanceMeters: z.number().int().optional(),
  workingHours: WorkingHoursSchema,
  timezone: z.string(),
  isOpenNow: z.boolean(),
  opensNextAt: z.string().datetime().nullable(),
  status: z.nativeEnum(MarketStatus),
  shopCount: z.number().int(),
  productCount: z.number().int(),
});

export const ShopResponseSchema = z.object({
  id: ObjectIdSchema,
  slug: z.string(),
  name: z.union([z.string(), LocalizedTextSchema]),
  contactPhone: z.string(),
  marketId: ObjectIdSchema,
  sectionCode: z.string().nullable(),
  stallNo: z.string().nullable(),
  isOpenNow: z.boolean(),
  isVisible: z.boolean(),
  moderationStatus: z.nativeEnum(ModerationStatus).optional(),
  rating: z.object({ avg: z.number(), count: z.number().int() }),
  productCount: z.number().int(),
});
