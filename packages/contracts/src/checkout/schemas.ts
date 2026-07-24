import { z } from 'zod';
import { MoneySchema, ObjectIdSchema, QuantitySchema } from '../common/primitives.js';

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
      shopName: z.union([z.string(), z.record(z.string())]),
      marketName: z.union([z.string(), z.record(z.string())]),
      lines: z.array(
        z.object({
          lineId: z.string(),
          productId: ObjectIdSchema,
          name: z.union([z.string(), z.record(z.string())]),
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
