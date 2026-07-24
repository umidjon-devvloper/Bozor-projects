import { Schema, model, type Model, type Types } from 'mongoose';
import { MAX_CART_ITEMS } from '../checkout.constants.js';

export interface CartItem {
  lineId: string;
  productId: Types.ObjectId;
  shopId: Types.ObjectId;
  qtyMilli: bigint;
  /**
   * Display only, never used in any calculation.
   *
   * It exists so the cart can say "this got more expensive since you added it". The
   * authoritative price comes from the checkout quote, which re-reads it from the product
   * (CART_CHECKOUT.md). Naming it `priceAtAdd` rather than `price` is deliberate: a future
   * reader must not mistake it for something to total up.
   */
  priceAtAdd: bigint;
  addedAt: Date;
}

export interface CartDoc {
  _id: Types.ObjectId;
  buyerId: Types.ObjectId;
  items: CartItem[];
  lastActivityAt: Date;
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const cartItemSchema = new Schema<CartItem>(
  {
    lineId: { type: String, required: true, maxlength: 32 },
    productId: { type: Schema.Types.ObjectId, required: true, ref: 'Product' },
    shopId: { type: Schema.Types.ObjectId, required: true, ref: 'Shop' },
    qtyMilli: { type: BigInt, required: true },
    priceAtAdd: { type: BigInt, required: true },
    addedAt: { type: Date, required: true, default: () => new Date() },
  },
  { _id: false },
);

const cartSchema = new Schema<CartDoc>(
  {
    buyerId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    items: {
      type: [cartItemSchema],
      default: [],
      validate: {
        validator: (v: CartItem[]) => v.length <= MAX_CART_ITEMS,
        message: `A cart may hold at most ${MAX_CART_ITEMS} lines`,
      },
    },
    lastActivityAt: { type: Date, required: true, default: () => new Date() },
    schemaVersion: { type: Number, required: true, default: 1 },
  },
  { timestamps: true, collection: 'carts', strict: 'throw', minimize: false },
);

cartSchema.index({ buyerId: 1 }, { unique: true });
// Abandoned carts are reclaimed after 90 days of silence.
cartSchema.index({ lastActivityAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

cartSchema.pre('validate', function enforceUniqueProducts(next) {
  const ids = this.items.map((item) => item.productId.toString());
  if (new Set(ids).size !== ids.length) {
    next(new Error('A product may appear only once in a cart; increase its quantity instead'));
    return;
  }
  for (const item of this.items) {
    if (item.qtyMilli <= 0n) {
      next(new Error('Cart quantities must be greater than zero'));
      return;
    }
  }
  next();
});

export const CartModel: Model<CartDoc> = model<CartDoc>('Cart', cartSchema);
