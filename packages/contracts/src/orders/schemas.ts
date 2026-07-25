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

/**
 * An order as a client receives it.
 *
 * Brought in line with `toOrderResponse` during the web build: the previous shape was a subset
 * written before the module was finished and had drifted — no `groupId`, no pickup window, no
 * stall address, and names typed as `LocalizedText` unions when the mapper resolves them to a
 * string before sending. Every client reading the old shape was either missing fields or
 * defending against a case the server never produces.
 *
 * Two fields are decisions rather than data. `shop.phone` is null while a buyer's order is
 * still PENDING, so an unanswered order cannot be used to harvest stall numbers. And
 * `canCancel` / `canConfirm` / `canDispute` are computed by the server from the state machine
 * rather than inferred per client: a button that appears when the action would be refused is
 * worse than no button at all.
 */
export const OrderResponseSchema = z.object({
  id: ObjectIdSchema,
  orderNo: z.string(),
  groupId: z.string(),
  status: OrderStatusSchema,
  shop: z.object({
    id: ObjectIdSchema,
    name: z.string(),
    marketName: z.string(),
    sectionCode: z.string().nullable(),
    stallNo: z.string().nullable(),
    phone: z.string().nullable(),
  }),
  lines: z.array(
    z.object({
      lineId: z.string(),
      productId: ObjectIdSchema,
      name: z.string(),
      slug: z.string(),
      imageUrl: z.string().nullable(),
      unit: z.string(),
      orderedQty: z.object({ value: z.string(), unit: z.string() }),
      confirmedQty: z.object({ value: z.string(), unit: z.string() }).nullable(),
      unitPrice: MoneyDTOSchema,
      lineTotal: MoneyDTOSchema,
      tolerancePercent: z.number().int(),
      adjustmentStatus: z.string().nullable(),
    }),
  ),
  totals: z.object({
    items: MoneyDTOSchema,
    adjustment: MoneyDTOSchema,
    discount: MoneyDTOSchema,
    grand: MoneyDTOSchema,
  }),
  paymentMode: z.enum(['CASH_ON_PICKUP', 'PREPAID_ONLINE']),
  pickupWindow: z.object({ from: z.string(), to: z.string() }).nullable(),
  acceptDeadline: z.string().nullable(),
  autoCompleteAt: z.string().nullable(),
  disputeDeadline: z.string().nullable(),
  hasAdjustment: z.boolean(),
  cancelledBy: z.string().nullable(),
  cancelReasonCode: z.string().nullable(),
  cancelReason: z.string().nullable(),
  note: z.string().nullable(),
  canCancel: z.boolean(),
  canConfirm: z.boolean(),
  canDispute: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type OrderResponse = z.infer<typeof OrderResponseSchema>;
