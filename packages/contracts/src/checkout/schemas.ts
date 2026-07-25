import { z } from 'zod';
import { MoneySchema, ObjectIdSchema, QuantitySchema } from '../common/primitives.js';
import { MoneyResponseSchema, QuantityResponseSchema } from '../catalog/schemas.js';

const MinorUnitString = z.string().regex(/^\d{1,19}$/, 'Must be an integer string of minor units');
const LineIdSchema = z.string().regex(/^[a-f0-9]{16}$/, 'Invalid cart line id');

export const LineIssueSchema = z.enum([
  'PRODUCT_GONE',
  'PRODUCT_NOT_VISIBLE',
  'SHOP_NOT_VISIBLE',
  'OUT_OF_STOCK',
  'INSUFFICIENT_STOCK',
  'BELOW_MIN_ORDER',
  'ABOVE_MAX_ORDER',
  'NOT_A_MULTIPLE_OF_STEP',
  'PRICE_CHANGED',
]);

export const AddCartItemRequestSchema = z
  .object({ productId: ObjectIdSchema, qty: MinorUnitString })
  .strict();

export const UpdateCartItemRequestSchema = z.object({ qty: MinorUnitString }).strict();

export const MergeCartRequestSchema = z
  .object({
    items: z
      .array(z.object({ productId: ObjectIdSchema, qty: MinorUnitString }).strict())
      .min(1)
      .max(100),
  })
  .strict();

/**
 * The quote request carries no prices and no totals.
 *
 * A client cannot contribute to what it will be charged; it names the lines and the server
 * prices them (CART_CHECKOUT.md). `promoCode` is deliberately absent — there is no
 * promotions module yet, and a field that silently does nothing is worse than none.
 */
export const CreateQuoteRequestSchema = z
  .object({ lineIds: z.array(LineIdSchema).max(100).optional() })
  .strict();

export const QuoteResponseSchema = z.object({
  quoteId: z.string(),
  expiresAt: z.string().datetime(),
  paymentMode: z.enum(['CASH_ON_PICKUP', 'PREPAID_ONLINE']),
  groups: z.array(
    z.object({
      shopId: ObjectIdSchema,
      /**
       * Already localised by the server: the quote mapper resolves `LocalizedText` against the
       * request's language before sending. Typing it as a union made every client handle a case
       * the API never produces, and the wider type is what a client would defensively code
       * around rather than a shape it would ever receive.
       */
      shopName: z.string(),
      marketName: z.string(),
      lines: z.array(
        z.object({
          lineId: z.string(),
          productId: ObjectIdSchema,
          name: z.string(),
          qty: QuantitySchema,
          unitPrice: MoneySchema,
          lineTotal: MoneySchema,
          tolerancePercent: z.number().int(),
        }),
      ),
      subtotal: MoneySchema,
      total: MoneySchema,
      pickupWindow: z.object({ from: z.string().datetime(), to: z.string().datetime() }),
    }),
  ),
  grandTotal: MoneySchema,
  issues: z.array(
    z.object({ lineId: z.string(), productId: ObjectIdSchema, code: LineIssueSchema }),
  ),
});

/**
 * The cart as the API returns it.
 *
 * Written down here rather than left implicit in the mapper because three clients read it and
 * a shape that only exists in a controller is a shape each of them re-guesses. Issues are per
 * line on purpose: a buyer with twelve items and one problem needs to know which one.
 */
export const CartLineResponseSchema = z.object({
  lineId: z.string(),
  productId: z.string(),
  shopId: z.string(),
  name: z.string(),
  slug: z.string(),
  imageUrl: z.string().nullable(),
  qty: QuantityResponseSchema,
  unitPrice: MoneyResponseSchema.nullable(),
  lineTotal: MoneyResponseSchema.nullable(),
  priceChanged: z.boolean(),
  purchasable: z.boolean(),
  issues: z.array(z.object({ code: z.string() }).passthrough()),
});

export const CartResponseSchema = z.object({
  items: z.array(CartLineResponseSchema),
  shopGroups: z.array(
    z.object({ shopId: z.string(), lineIds: z.array(z.string()), subtotal: MoneyResponseSchema }),
  ),
  subtotal: MoneyResponseSchema,
  itemCount: z.number().int(),
  hasIssues: z.boolean(),
  updatedAt: z.string(),
});

export type CartLineResponse = z.infer<typeof CartLineResponseSchema>;
export type CartResponse = z.infer<typeof CartResponseSchema>;
export type QuoteResponse = z.infer<typeof QuoteResponseSchema>;
