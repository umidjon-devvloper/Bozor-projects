/**
 * Cart & checkout: collection validators and indexes (ADR-0026, ADR-0032).
 *
 * `stock_reservations` deliberately has no TTL index. Deleting an expired hold before anything
 * decrements `products.reservedQtyMilli` would leak the counter upward and strand real stock;
 * the sweeper owns expiry and does both writes in one transaction.
 */
const localizedText = {
  bsonType: 'object',
  required: ['uz'],
  properties: {
    uz: { bsonType: 'string', minLength: 1, maxLength: 200 },
    uzCyrl: { bsonType: 'string', maxLength: 200 },
    ru: { bsonType: 'string', maxLength: 200 },
    en: { bsonType: 'string', maxLength: 200 },
  },
};

async function ensure(db, name, validator) {
  const existing = await db.listCollections({ name }).toArray();
  if (existing.length === 0) {
    await db.createCollection(name, {
      validator: { $jsonSchema: validator },
      validationLevel: 'strict',
      validationAction: 'error',
    });
  } else {
    await db.command({
      collMod: name,
      validator: { $jsonSchema: validator },
      validationLevel: 'strict',
      validationAction: 'error',
    });
  }
}

module.exports = {
  async up(db) {
    await ensure(db, 'carts', {
      bsonType: 'object',
      required: ['buyerId', 'items', 'lastActivityAt', 'schemaVersion'],
      properties: {
        buyerId: { bsonType: 'objectId' },
        items: {
          bsonType: 'array',
          maxItems: 100,
          items: {
            bsonType: 'object',
            required: ['lineId', 'productId', 'shopId', 'qtyMilli', 'priceAtAdd', 'addedAt'],
            additionalProperties: false,
            properties: {
              lineId: { bsonType: 'string', maxLength: 32 },
              productId: { bsonType: 'objectId' },
              shopId: { bsonType: 'objectId' },
              qtyMilli: { bsonType: 'long', minimum: 1 },
              priceAtAdd: { bsonType: 'long', minimum: 0 },
              addedAt: { bsonType: 'date' },
            },
          },
        },
      },
    });
    await db.collection('carts').createIndex({ buyerId: 1 }, { unique: true, name: 'buyer_unique' });
    await db
      .collection('carts')
      .createIndex({ lastActivityAt: 1 }, { name: 'abandoned_ttl', expireAfterSeconds: 60 * 60 * 24 * 90 });

    await ensure(db, 'stock_reservations', {
      bsonType: 'object',
      required: [
        'productId', 'shopId', 'buyerId', 'holderType', 'holderId',
        'qtyMilli', 'status', 'expiresAt', 'schemaVersion',
      ],
      properties: {
        productId: { bsonType: 'objectId' },
        buyerId: { bsonType: 'objectId' },
        holderType: { enum: ['QUOTE', 'ORDER'] },
        holderId: { bsonType: 'string', maxLength: 64 },
        qtyMilli: { bsonType: 'long', minimum: 1 },
        status: { enum: ['ACTIVE', 'COMMITTED', 'RELEASED', 'EXPIRED'] },
      },
    });
    const reservations = db.collection('stock_reservations');
    await reservations.createIndex({ holderId: 1, status: 1 }, { name: 'holder_lookup' });
    await reservations.createIndex(
      { productId: 1, status: 1 },
      { name: 'product_active', partialFilterExpression: { status: 'ACTIVE' } },
    );
    await reservations.createIndex(
      { status: 1, expiresAt: 1 },
      { name: 'sweeper_cursor', partialFilterExpression: { status: 'ACTIVE' } },
    );
    await reservations.createIndex({ buyerId: 1, createdAt: -1 }, { name: 'buyer_history' });

    await ensure(db, 'checkout_quotes', {
      bsonType: 'object',
      required: [
        'quoteId', 'buyerId', 'groups', 'grandTotal', 'currency',
        'paymentMode', 'contentHash', 'status', 'expiresAt', 'schemaVersion',
      ],
      properties: {
        quoteId: { bsonType: 'string', maxLength: 64 },
        buyerId: { bsonType: 'objectId' },
        grandTotal: { bsonType: 'long', minimum: 0 },
        currency: { enum: ['UZS'] },
        paymentMode: { enum: ['CASH_ON_PICKUP', 'PREPAID_ONLINE'] },
        contentHash: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
        status: { enum: ['ACTIVE', 'CONSUMED', 'EXPIRED', 'SUPERSEDED'] },
        groups: {
          bsonType: 'array',
          minItems: 1,
          maxItems: 20,
          items: {
            bsonType: 'object',
            required: ['shopId', 'shopName', 'marketId', 'marketName', 'lines', 'subtotal', 'total'],
            properties: {
              shopName: localizedText,
              marketName: localizedText,
              subtotal: { bsonType: 'long', minimum: 0 },
              total: { bsonType: 'long', minimum: 0 },
            },
          },
        },
      },
    });
    await db.collection('checkout_quotes').createIndex({ quoteId: 1 }, { unique: true, name: 'quote_unique' });
    await db.collection('checkout_quotes').createIndex({ buyerId: 1, status: 1 }, { name: 'buyer_status' });
    // Kept 30 days past expiry: a dispute about what was offered is answered from here.
    await db
      .collection('checkout_quotes')
      .createIndex({ expiresAt: 1 }, { name: 'quote_retention', expireAfterSeconds: 60 * 60 * 24 * 30 });
  },

  async down(db) {
    for (const name of ['checkout_quotes', 'stock_reservations', 'carts']) {
      const existing = await db.listCollections({ name }).toArray();
      if (existing.length === 0) continue;
      await db.command({ collMod: name, validator: {}, validationLevel: 'off' });
      const indexes = await db.collection(name).indexes();
      for (const index of indexes) {
        if (index.name !== '_id_') await db.collection(name).dropIndex(index.name);
      }
    }
  },
};
