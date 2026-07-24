import { z } from 'zod';
import { ObjectIdSchema } from '../common/primitives.js';

const MinorUnitString = z.string().regex(/^\d{1,19}$/, 'Must be an integer string of minor units');

/**
 * Search accepts a free-text term and the same filters the catalogue exposes.
 *
 * Every filter is an explicit, named field rather than a pass-through query language: the
 * server builds the engine's filter string, so nothing a caller sends can reach it directly.
 */
export const ProductSearchQuerySchema = z
  .object({
    q: z.string().trim().max(120).optional(),
    categoryId: ObjectIdSchema.optional(),
    marketId: ObjectIdSchema.optional(),
    districtId: ObjectIdSchema.optional(),
    regionId: ObjectIdSchema.optional(),
    shopId: ObjectIdSchema.optional(),
    priceMin: MinorUnitString.optional(),
    priceMax: MinorUnitString.optional(),
    inStockOnly: z.coerce.boolean().optional(),
    ratingMin: z.coerce.number().min(0).max(5).optional(),
    sort: z.enum(['relevance', 'price', '-price', '-rating', '-popularity', 'distance']).optional(),
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    page: z.coerce.number().int().min(1).max(100).optional(),
    perPage: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict()
  .refine((value) => value.sort !== 'distance' || (value.lat !== undefined && value.lng !== undefined), {
    message: 'Sorting by distance requires lat and lng',
    path: ['sort'],
  });

export const ShopSearchQuerySchema = z
  .object({
    q: z.string().trim().max(120).optional(),
    marketId: ObjectIdSchema.optional(),
    districtId: ObjectIdSchema.optional(),
    page: z.coerce.number().int().min(1).max(100).optional(),
    perPage: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();

export const SuggestQuerySchema = z.object({ q: z.string().trim().min(2).max(120) }).strict();

export const SearchResultSchema = z.object({
  items: z.array(z.record(z.unknown())),
  found: z.number().int(),
  page: z.number().int(),
  perPage: z.number().int(),
  facets: z.record(z.array(z.object({ value: z.string(), count: z.number().int() }))),
});
