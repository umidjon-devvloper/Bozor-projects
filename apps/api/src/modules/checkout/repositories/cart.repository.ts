import { Types } from 'mongoose';
import { Money, Quantity } from '@bozorlar/money';
import { CartModel, type CartDoc, type CartItem } from '../models/cart.model.js';

export interface CartLineRecord {
  lineId: string;
  productId: string;
  shopId: string;
  qty: Quantity;
  priceAtAdd: Money;
  addedAt: Date;
}

export interface CartRecord {
  id: string;
  buyerId: string;
  lines: CartLineRecord[];
  updatedAt: Date;
}

function toRecord(doc: CartDoc, unitsByProduct: Map<string, string>): CartRecord {
  return {
    id: doc._id.toString(),
    buyerId: doc.buyerId.toString(),
    lines: doc.items.map((item) => ({
      lineId: item.lineId,
      productId: item.productId.toString(),
      shopId: item.shopId.toString(),
      // The unit is a property of the product, not the cart, so it is resolved by the caller
      // and passed in rather than duplicated onto every line.
      qty: Quantity.of(item.qtyMilli, unitsByProduct.get(item.productId.toString()) ?? 'unit'),
      priceAtAdd: Money.of(item.priceAtAdd),
      addedAt: item.addedAt,
    })),
    updatedAt: doc.updatedAt,
  };
}

export const cartRepository = {
  async findRaw(buyerId: string): Promise<CartDoc | null> {
    return CartModel.findOne({ buyerId }).lean<CartDoc>();
  },

  async find(buyerId: string, unitsByProduct: Map<string, string>): Promise<CartRecord | null> {
    const doc = await CartModel.findOne({ buyerId }).lean<CartDoc>();
    return doc ? toRecord(doc, unitsByProduct) : null;
  },

  /**
   * Adds a line, or increases the quantity if the product is already there.
   *
   * Two operations rather than one upsert, because "same product again" must add to the
   * existing line: a cart with the same tomato on three rows is a bug the buyer has to fix
   * by hand.
   */
  async addOrIncrement(
    buyerId: string,
    input: { lineId: string; productId: string; shopId: string; qty: Quantity; price: Money },
  ): Promise<void> {
    const incremented = await CartModel.updateOne(
      { buyerId, 'items.productId': new Types.ObjectId(input.productId) },
      {
        $inc: { 'items.$.qtyMilli': input.qty.milli },
        $set: { 'items.$.priceAtAdd': input.price.minor, lastActivityAt: new Date() },
      },
    );
    if (incremented.matchedCount === 1) return;

    await CartModel.updateOne(
      { buyerId },
      {
        $push: {
          items: {
            lineId: input.lineId,
            productId: new Types.ObjectId(input.productId),
            shopId: new Types.ObjectId(input.shopId),
            qtyMilli: input.qty.milli,
            priceAtAdd: input.price.minor,
            addedAt: new Date(),
          },
        },
        $set: { lastActivityAt: new Date() },
        $setOnInsert: { buyerId: new Types.ObjectId(buyerId), schemaVersion: 1 },
      },
      { upsert: true, setDefaultsOnInsert: true, runValidators: true },
    );
  },

  async setQuantity(buyerId: string, lineId: string, qty: Quantity): Promise<boolean> {
    const result = await CartModel.updateOne(
      { buyerId, 'items.lineId': lineId },
      { $set: { 'items.$.qtyMilli': qty.milli, lastActivityAt: new Date() } },
    );
    return result.matchedCount === 1;
  },

  async removeLine(buyerId: string, lineId: string): Promise<boolean> {
    const result = await CartModel.updateOne(
      { buyerId },
      { $pull: { items: { lineId } }, $set: { lastActivityAt: new Date() } },
    );
    return result.modifiedCount === 1;
  },

  async removeProducts(buyerId: string, productIds: readonly string[]): Promise<number> {
    if (productIds.length === 0) return 0;
    const result = await CartModel.updateOne(
      { buyerId },
      {
        $pull: { items: { productId: { $in: productIds.map((id) => new Types.ObjectId(id)) } } },
        $set: { lastActivityAt: new Date() },
      },
    );
    return result.modifiedCount;
  },

  async clear(buyerId: string): Promise<void> {
    await CartModel.updateOne({ buyerId }, { $set: { items: [], lastActivityAt: new Date() } });
  },

  async ensureExists(buyerId: string): Promise<void> {
    await CartModel.updateOne(
      { buyerId },
      { $setOnInsert: { buyerId: new Types.ObjectId(buyerId), items: [], schemaVersion: 1 } },
      { upsert: true, setDefaultsOnInsert: true },
    );
  },

  async countItems(buyerId: string): Promise<number> {
    const doc = await CartModel.findOne({ buyerId }, { items: 1 }).lean<Pick<CartDoc, 'items'>>();
    return doc?.items.length ?? 0;
  },

  toRecord(doc: CartDoc, unitsByProduct: Map<string, string>): CartRecord {
    return toRecord(doc, unitsByProduct);
  },

  emptyRecord(buyerId: string): CartRecord {
    return { id: '', buyerId, lines: [], updatedAt: new Date() };
  },

  itemsOf(doc: CartDoc): CartItem[] {
    return doc.items;
  },
};
