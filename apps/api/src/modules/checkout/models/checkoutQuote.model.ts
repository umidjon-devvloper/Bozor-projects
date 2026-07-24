import { Schema, model, type Model, type Types } from 'mongoose';
import type { LocalizedText } from '@bozorlar/types';

/**
 * A priced, reserved, time-boxed offer.
 *
 * The quote is the authoritative statement of what the buyer will pay (CART_CHECKOUT.md), so
 * every line carries a frozen snapshot rather than a reference. Order creation reads this
 * document, not the cart and not the live products — which is what makes "the price changed
 * between the screen and the button" impossible rather than merely unlikely.
 */
export interface QuoteLine {
  lineId: string;
  productId: Types.ObjectId;
  productName: LocalizedText;
  productSlug: string;
  imageKey: string | null;
  unit: string;
  unitPrice: bigint;
  qtyMilli: bigint;
  lineTotal: bigint;
  tolerancePercent: number;
}

export interface QuoteGroup {
  shopId: Types.ObjectId;
  shopName: LocalizedText;
  marketId: Types.ObjectId;
  marketName: LocalizedText;
  lines: QuoteLine[];
  subtotal: bigint;
  total: bigint;
  pickupFrom: Date;
  pickupTo: Date;
}

export interface CheckoutQuoteDoc {
  _id: Types.ObjectId;
  quoteId: string;
  buyerId: Types.ObjectId;
  groups: QuoteGroup[];
  grandTotal: bigint;
  currency: string;
  paymentMode: 'CASH_ON_PICKUP' | 'PREPAID_ONLINE';
  /**
   * Digest of every price and quantity in the quote.
   *
   * Order creation recomputes it against live products; a mismatch means something moved
   * underneath and the buyer is re-quoted rather than charged a different amount.
   */
  contentHash: string;
  status: 'ACTIVE' | 'CONSUMED' | 'EXPIRED' | 'SUPERSEDED';
  consumedAt: Date | null;
  consumedByOrderGroupId: Types.ObjectId | null;
  expiresAt: Date;
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const localized = {
  uz: { type: String, required: true, maxlength: 200 },
  uzCyrl: { type: String, maxlength: 200 },
  ru: { type: String, maxlength: 200 },
  en: { type: String, maxlength: 200 },
};

const quoteLineSchema = new Schema<QuoteLine>(
  {
    lineId: { type: String, required: true, maxlength: 32 },
    productId: { type: Schema.Types.ObjectId, required: true },
    productName: { type: localized, required: true },
    productSlug: { type: String, required: true, maxlength: 160 },
    imageKey: { type: String, default: null, maxlength: 256 },
    unit: { type: String, required: true, maxlength: 16 },
    unitPrice: { type: BigInt, required: true },
    qtyMilli: { type: BigInt, required: true },
    lineTotal: { type: BigInt, required: true },
    tolerancePercent: { type: Number, required: true },
  },
  { _id: false },
);

const quoteGroupSchema = new Schema<QuoteGroup>(
  {
    shopId: { type: Schema.Types.ObjectId, required: true },
    shopName: { type: localized, required: true },
    marketId: { type: Schema.Types.ObjectId, required: true },
    marketName: { type: localized, required: true },
    lines: { type: [quoteLineSchema], required: true },
    subtotal: { type: BigInt, required: true },
    total: { type: BigInt, required: true },
    pickupFrom: { type: Date, required: true },
    pickupTo: { type: Date, required: true },
  },
  { _id: false },
);

const quoteSchema = new Schema<CheckoutQuoteDoc>(
  {
    quoteId: { type: String, required: true, maxlength: 64 },
    buyerId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    groups: { type: [quoteGroupSchema], required: true },
    grandTotal: { type: BigInt, required: true },
    currency: { type: String, required: true, default: 'UZS' },
    paymentMode: {
      type: String,
      enum: ['CASH_ON_PICKUP', 'PREPAID_ONLINE'],
      required: true,
      default: 'CASH_ON_PICKUP',
    },
    contentHash: { type: String, required: true, maxlength: 64 },
    status: {
      type: String,
      enum: ['ACTIVE', 'CONSUMED', 'EXPIRED', 'SUPERSEDED'],
      required: true,
      default: 'ACTIVE',
    },
    consumedAt: { type: Date, default: null },
    consumedByOrderGroupId: { type: Schema.Types.ObjectId, default: null },
    expiresAt: { type: Date, required: true },
    schemaVersion: { type: Number, required: true, default: 1 },
  },
  { timestamps: true, collection: 'checkout_quotes', strict: 'throw', minimize: false },
);

quoteSchema.index({ quoteId: 1 }, { unique: true });
quoteSchema.index({ buyerId: 1, status: 1 });
// Retained well past expiry: a dispute about what was offered is answered from here.
quoteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

quoteSchema.pre('validate', function enforceTotals(next) {
  let grand = 0n;
  for (const group of this.groups) {
    const subtotal = group.lines.reduce((sum, line) => sum + line.lineTotal, 0n);
    if (subtotal !== group.subtotal) {
      next(new Error('Group subtotal does not equal the sum of its lines'));
      return;
    }
    grand += group.total;
  }
  if (grand !== this.grandTotal) {
    next(new Error('Grand total does not equal the sum of the groups'));
    return;
  }
  next();
});

export const CheckoutQuoteModel: Model<CheckoutQuoteDoc> = model<CheckoutQuoteDoc>(
  'CheckoutQuote',
  quoteSchema,
);
