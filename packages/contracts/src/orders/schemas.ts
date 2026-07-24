import { z } from 'zod';
import { ObjectIdSchema } from '../common/primitives.js';

const MinorUnitString = z.string().regex(/^\d{1,19}$/, 'Must be an integer string of minor units');
const LineIdSchema = z.string().regex(/^[a-f0-9]{16}$/, 'Invalid line id');

export const OrderStatusSchema = z.enum([
  'PENDING',
  'ACCEPTED',
  'PREPARING',
  'READY_FOR_PICKUP',
  'PENDING_ADJUSTMENT',
  'PICKED_UP',
  'COMPLETED',
  'REJECTED',
  'EXPIRED',
  'CANCELLED',
  'DISPUTED',
  'REFUNDED',
]);

export const CancelReasonCodeSchema = z.enum([
  'CHANGED_MIND',
  'FOUND_ELSEWHERE',
  'TOO_SLOW',
  'OUT_OF_STOCK',
  'CANNOT_FULFIL',
  'BUYER_NO_SHOW',
  'ADJUSTMENT_REJECTED',
  'ADJUSTMENT_TIMEOUT',
  'ACCEPT_WINDOW_EXPIRED',
  'OTHER',
]);

/**
 * Order creation names a quote and nothing else.
 *
 * No prices, no quantities, no totals: the quote already fixed all of them, server-side.
 * Anything the client could send here would be a second source of truth for money.
 */
export const CreateOrderRequestSchema = z
  .object({ quoteId: z.string().regex(/^q_[a-f0-9]{24}$/), note: z.string().trim().max(500).optional() })
  .strict();

export const CancelOrderRequestSchema = z
  .object({ reasonCode: CancelReasonCodeSchema, reason: z.string().trim().min(3).max(500).optional() })
  .strict();

export const RejectOrderRequestSchema = z
  .object({ reasonCode: CancelReasonCodeSchema, reason: z.string().trim().min(3).max(500) })
  .strict();

export const VerifyPickupRequestSchema = z
  .object({ code: z.string().regex(/^\d{6}$/, 'Pickup code is six digits') })
  .strict();

export const ProposeAdjustmentRequestSchema = z
  .object({
    lines: z
      .array(z.object({ lineId: LineIdSchema, confirmedQty: MinorUnitString }).strict())
      .min(1)
      .max(50),
  })
  .strict();

export const RespondToAdjustmentRequestSchema = z.object({ approved: z.boolean() }).strict();

export const MoneyDTOSchema = z.object({ amount: z.string(), currency: z.literal('UZS') });

export const OrderResponseSchema = z.object({
  id: ObjectIdSchema,
  orderNo: z.string(),
  status: OrderStatusSchema,
  shop: z.object({ id: ObjectIdSchema, name: z.union([z.string(), z.record(z.string())]) }),
  lines: z.array(
    z.object({
      lineId: z.string(),
      name: z.union([z.string(), z.record(z.string())]),
      orderedQty: z.object({ value: z.string(), unit: z.string() }),
      confirmedQty: z.object({ value: z.string(), unit: z.string() }).nullable(),
      unitPrice: MoneyDTOSchema,
      lineTotal: MoneyDTOSchema,
    }),
  ),
  totals: z.object({ items: MoneyDTOSchema, adjustment: MoneyDTOSchema, grand: MoneyDTOSchema }),
  canCancel: z.boolean(),
  canConfirm: z.boolean(),
  createdAt: z.string().datetime(),
});
