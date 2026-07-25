import { z } from 'zod';
import { LocalizedTextSchema, ObjectIdSchema } from '../common/primitives.js';

/** Integer minor units as strings (ADR-0028); parsed by Money/Quantity server-side. */
const MinorUnitString = z.string().regex(/^\d{1,19}$/, 'Must be an integer string of minor units');

export const ProductStatusSchema = z.enum([
  'DRAFT',
  'PENDING_MODERATION',
  'ACTIVE',
  'OUT_OF_STOCK',
  'ARCHIVED',
]);

export const AttributeTypeSchema = z.enum(['STRING', 'NUMBER', 'BOOLEAN', 'ENUM']);

export const AttributeDefinitionSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]*$/).max(40),
    type: AttributeTypeSchema,
    name: LocalizedTextSchema,
    options: z.array(z.string().max(100)).max(50).default([]),
    required: z.boolean().default(false),
    order: z.number().int().min(0).max(100).default(0),
  })
  .strict();

export const CreateCategoryRequestSchema = z
  .object({
    parentId: ObjectIdSchema.nullable().default(null),
    name: LocalizedTextSchema,
    description: LocalizedTextSchema.optional(),
    icon: z.string().max(64).optional(),
    defaultUnit: z.string().min(1).max(16),
    allowedUnits: z.array(z.string().min(1).max(16)).min(1).max(10),
    defaultTolerancePercent: z.number().int().min(0).max(5000).optional(),
    attributeSchema: z.array(AttributeDefinitionSchema).max(30).optional(),
    order: z.number().int().min(0).max(9999).optional(),
  })
  .strict();

export const UpdateCategoryRequestSchema = z
  .object({
    name: LocalizedTextSchema.optional(),
    description: LocalizedTextSchema.optional(),
    icon: z.string().max(64).optional(),
    defaultUnit: z.string().min(1).max(16).optional(),
    allowedUnits: z.array(z.string().min(1).max(16)).min(1).max(10).optional(),
    defaultTolerancePercent: z.number().int().min(0).max(5000).optional(),
    attributeSchema: z.array(AttributeDefinitionSchema).max(30).optional(),
    order: z.number().int().min(0).max(9999).optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'At least one field is required' });

export const CreateProductRequestSchema = z
  .object({
    shopId: ObjectIdSchema,
    categoryId: ObjectIdSchema,
    name: LocalizedTextSchema,
    description: LocalizedTextSchema.optional(),
    images: z.array(z.string().min(8).max(256)).min(1).max(10),
    unit: z.string().min(1).max(16),
    price: MinorUnitString,
    oldPrice: MinorUnitString.optional(),
    stockQty: MinorUnitString,
    minOrderQty: MinorUnitString,
    stepQty: MinorUnitString,
    maxOrderQty: MinorUnitString.optional(),
    tolerancePercent: z.number().int().min(0).max(5000).optional(),
    attributes: z.record(z.unknown()).optional(),
    tags: z.array(z.string().trim().min(1).max(32)).max(20).optional(),
  })
  .strict();

export const UpdateProductRequestSchema = z
  .object({
    name: LocalizedTextSchema.optional(),
    description: LocalizedTextSchema.optional(),
    categoryId: ObjectIdSchema.optional(),
    images: z.array(z.string().min(8).max(256)).min(1).max(10).optional(),
    attributes: z.record(z.unknown()).optional(),
    tags: z.array(z.string().trim().min(1).max(32)).max(20).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'At least one field is required' });

/** Price and stock have their own endpoints: they are the highest-frequency seller writes. */
export const SetPriceRequestSchema = z
  .object({ price: MinorUnitString, oldPrice: MinorUnitString.nullable().optional() })
  .strict();

export const SetStockRequestSchema = z.object({ stockQty: MinorUnitString }).strict();

export const ModerateProductRequestSchema = z
  .object({ approved: z.boolean(), reason: z.string().trim().min(10).max(1000).optional() })
  .strict()
  .refine((value) => value.approved || value.reason !== undefined, {
    message: 'A reason is required when rejecting',
    path: ['reason'],
  });

export const PriceHistoryQuerySchema = z
  .object({ period: z.enum(['30d', '90d', '1y']).default('30d') })
  .strict();

export const MoneyResponseSchema = z.object({ amount: z.string(), currency: z.literal('UZS') });
export const QuantityResponseSchema = z.object({ value: z.string(), unit: z.string() });

export const ProductResponseSchema = z.object({
  id: ObjectIdSchema,
  slug: z.string(),
  name: z.union([z.string(), LocalizedTextSchema]),
  price: MoneyResponseSchema,
  oldPrice: MoneyResponseSchema.nullable(),
  discountPercent: z.number().int().nullable(),
  availableQty: QuantityResponseSchema,
  minOrderQty: QuantityResponseSchema,
  stepQty: QuantityResponseSchema,
  tolerancePercent: z.number().int(),
  inStock: z.boolean(),
  isPurchasable: z.boolean(),
  rating: z.object({ avg: z.number(), count: z.number().int() }),
});

/** Response types, inferred from the schemas above — see the note in `geo/schemas.ts`. */
export type MoneyResponse = z.infer<typeof MoneyResponseSchema>;
export type QuantityResponse = z.infer<typeof QuantityResponseSchema>;
export type ProductResponse = z.infer<typeof ProductResponseSchema>;
