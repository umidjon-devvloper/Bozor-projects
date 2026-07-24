import { Schema, model, type Model, type Types } from 'mongoose';
import { ReservationStatus } from '../checkout.constants.js';

/**
 * A hold on stock (ADR-0032).
 *
 * The document and the `$inc` on `products.reservedQtyMilli` are written in the same
 * transaction, so a hold and its record cannot exist independently. Nothing here is deleted
 * on expiry: the row moves to EXPIRED and stays, because it is the only evidence of why a
 * quantity was unavailable to somebody else for fifteen minutes.
 */
export interface StockReservationDoc {
  _id: Types.ObjectId;
  productId: Types.ObjectId;
  shopId: Types.ObjectId;
  buyerId: Types.ObjectId;
  /** The quote that took the hold. Becomes the order id once the order is created. */
  holderType: 'QUOTE' | 'ORDER';
  holderId: string;
  qtyMilli: bigint;
  status: ReservationStatus;
  expiresAt: Date;
  releasedAt: Date | null;
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const reservationSchema = new Schema<StockReservationDoc>(
  {
    productId: { type: Schema.Types.ObjectId, required: true, ref: 'Product' },
    shopId: { type: Schema.Types.ObjectId, required: true },
    buyerId: { type: Schema.Types.ObjectId, required: true },
    holderType: { type: String, enum: ['QUOTE', 'ORDER'], required: true },
    holderId: { type: String, required: true, maxlength: 64 },
    qtyMilli: { type: BigInt, required: true },
    status: {
      type: String,
      enum: Object.values(ReservationStatus),
      required: true,
      default: ReservationStatus.ACTIVE,
    },
    expiresAt: { type: Date, required: true },
    releasedAt: { type: Date, default: null },
    schemaVersion: { type: Number, required: true, default: 1 },
  },
  { timestamps: true, collection: 'stock_reservations', strict: 'throw' },
);

reservationSchema.index({ holderId: 1, status: 1 });
reservationSchema.index(
  { productId: 1, status: 1 },
  { partialFilterExpression: { status: ReservationStatus.ACTIVE } },
);
/**
 * The sweeper cursor.
 *
 * Deliberately not a TTL index. TTL would delete the row before anything decremented
 * `products.reservedQtyMilli`, leaking the counter upward and stranding that stock forever —
 * the same trap the geo module hit with reservation expiry (DATABASE.md 2.4).
 */
reservationSchema.index(
  { status: 1, expiresAt: 1 },
  { partialFilterExpression: { status: ReservationStatus.ACTIVE } },
);
reservationSchema.index({ buyerId: 1, createdAt: -1 });

export const StockReservationModel: Model<StockReservationDoc> = model<StockReservationDoc>(
  'StockReservation',
  reservationSchema,
);
