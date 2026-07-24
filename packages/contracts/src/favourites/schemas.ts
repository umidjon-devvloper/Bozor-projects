import { z } from 'zod';
import { ObjectIdSchema } from '../common/primitives.js';

export const FavouriteTargetSchema = z.enum(['PRODUCT', 'SHOP']);

/**
 * Adding a favourite names what is being followed and nothing else.
 *
 * No alert preferences on creation: following something means wanting to hear about it, and a
 * request that could create a silent favourite would mostly create them by accident. Muting is
 * a separate, deliberate call.
 */
export const AddFavouriteRequestSchema = z
  .object({
    targetType: FavouriteTargetSchema,
    targetId: ObjectIdSchema,
  })
  .strict();

export const SetFavouriteAlertsRequestSchema = z
  .object({ alertsEnabled: z.boolean() })
  .strict();

export const ListFavouritesQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().max(64).optional(),
  })
  .strict();

/**
 * The bulk state check a catalogue page makes.
 *
 * Capped at the largest page the clients render. An uncapped `$in` is a cheap way to turn a
 * public endpoint into a database scan.
 */
export const FavouriteStatusQuerySchema = z
  .object({
    targetType: FavouriteTargetSchema.default('PRODUCT'),
    ids: z
      .string()
      .transform((value) => value.split(',').map((id) => id.trim()).filter(Boolean))
      .pipe(z.array(ObjectIdSchema).min(1).max(100)),
  })
  .strict();

export const FavouriteProductViewSchema = z.object({
  id: z.string(),
  productId: z.string(),
  shopId: z.string().nullable(),
  name: z.string(),
  slug: z.string(),
  image: z.string().nullable(),
  /** Money crosses the wire as a string (ADR-0028). */
  price: z.string(),
  priceWatermark: z.string().nullable(),
  unit: z.string(),
  isVisible: z.boolean(),
  isPurchasable: z.boolean(),
  /** Present so a client can explain a greyed-out card rather than just greying it out. */
  unavailableReason: z.string().nullable(),
  alertsEnabled: z.boolean(),
  createdAt: z.string(),
});

export const FavouriteShopViewSchema = z.object({
  id: z.string(),
  shopId: z.string(),
  name: z.string(),
  slug: z.string(),
  marketName: z.string().nullable(),
  isVisible: z.boolean(),
  createdAt: z.string(),
});

export const FavouriteStatusViewSchema = z.object({
  followed: z.array(z.string()),
});

export const FavouriteCountViewSchema = z.object({
  productId: z.string(),
  followers: z.number().int(),
  awaitingRestock: z.number().int(),
});

export type AddFavouriteRequest = z.infer<typeof AddFavouriteRequestSchema>;
export type SetFavouriteAlertsRequest = z.infer<typeof SetFavouriteAlertsRequestSchema>;
export type ListFavouritesQuery = z.infer<typeof ListFavouritesQuerySchema>;
export type FavouriteStatusQuery = z.infer<typeof FavouriteStatusQuerySchema>;
export type FavouriteProductView = z.infer<typeof FavouriteProductViewSchema>;
export type FavouriteShopView = z.infer<typeof FavouriteShopViewSchema>;
