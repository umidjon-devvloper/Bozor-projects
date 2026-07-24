/**
 * Orders: collection validators and indexes (ADR-0026).
 *
 * Money is declared `long` for the same reason as everywhere else: Mongoose casts correctly,
 * but a migration or an operator in mongosh could write a double, and a double order total is
 * a receipt that disagrees with itself.
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

const ORDER_STATUSES = [
  'PENDING', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'PENDING_ADJUSTMENT',
  'PICKED_UP', 'COMPLETED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'DISPUTED', 'REFUNDED',
];

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
    // Counters carry no validator: the document is `{_id: string, seq: int}` and is only ever
    // touched by $inc.
    const counters = await db.listCollections({ name: 'counters' }).toArray();
    if (counters.length === 0) await db.createCollection('counters');

    await ensure(db, 'order_groups', {
      bsonType: 'object',
      required: ['groupNo', 'buyerId', 'orderIds', 'quoteId', 'paymentMode', 'totals', 'derivedStatus', 'schemaVersion'],
      properties: {
        groupNo: { bsonType: 'string', pattern: '^BZG-[0-9]{6}-[0-9]{6}$' },
        buyerId: { bsonType: 'objectId' },
        orderIds: { bsonType: 'array', maxItems: 20, items: { bsonType: 'objectId' } },
        quoteId: { bsonType: 'string', maxLength: 64 },
        paymentMode: { enum: ['CASH_ON_PICKUP', 'PREPAID_ONLINE'] },
        derivedStatus: { enum: ['ACTIVE', 'PARTIALLY_COMPLETED', 'COMPLETED', 'CANCELLED'] },
      },
    });
    await db.collection('order_groups').createIndex({ groupNo: 1 }, { unique: true, name: 'group_no_unique' });
    // One group per quote: the backstop behind the quote's CONSUMED status.
    await db.collection('order_groups').createIndex({ quoteId: 1 }, { unique: true, name: 'quote_unique' });
    await db.collection('order_groups').createIndex({ buyerId: 1, createdAt: -1 }, { name: 'buyer_history' });

    await ensure(db, 'orders', {
      bsonType: 'object',
      required: [
        'orderNo', 'groupId', 'buyerId', 'shopId', 'sellerId', 'marketId',
        'shopSnapshot', 'buyerSnapshot', 'lines', 'status', 'paymentMode',
        'fulfilmentType', 'totals', 'commission', 'schemaVersion',
      ],
      properties: {
        orderNo: { bsonType: 'string', pattern: '^BZ-[0-9]{6}-[0-9]{6}$' },
        status: { enum: ORDER_STATUSES },
        paymentMode: { enum: ['CASH_ON_PICKUP', 'PREPAID_ONLINE'] },
        fulfilmentType: { enum: ['PICKUP', 'COURIER'] },
        // Only the hash is ever stored; the plaintext exists in one response and nowhere else.
        pickupCodeHash: { oneOf: [{ bsonType: 'string', pattern: '^[a-f0-9]{64}$' }, { bsonType: 'null' }] },
        pickupCodeAttempts: { bsonType: ['int', 'long'], minimum: 0, maximum: 10 },
        lines: {
          bsonType: 'array',
          minItems: 1,
          maxItems: 50,
          items: {
            bsonType: 'object',
            required: ['lineId', 'productId', 'productName', 'unit', 'unitPrice', 'orderedQtyMilli', 'lineTotal'],
            properties: {
              productName: localizedText,
              unitPrice: { bsonType: 'long', minimum: 1 },
              orderedQtyMilli: { bsonType: 'long', minimum: 1 },
              confirmedQtyMilli: { oneOf: [{ bsonType: 'long', minimum: 0 }, { bsonType: 'null' }] },
              lineTotal: { bsonType: 'long', minimum: 0 },
            },
          },
        },
        totals: {
          bsonType: 'object',
          required: ['items', 'grand'],
          properties: {
            items: { bsonType: 'long', minimum: 0 },
            adjustment: { bsonType: 'long' },
            discount: { bsonType: 'long', minimum: 0 },
            delivery: { bsonType: 'long', minimum: 0 },
            grand: { bsonType: 'long', minimum: 0 },
          },
        },
        commission: {
          bsonType: 'object',
          required: ['status'],
          properties: {
            status: { enum: ['PENDING', 'CHARGED', 'REVERSED', 'FAILED'] },
            amount: { oneOf: [{ bsonType: 'long', minimum: 0 }, { bsonType: 'null' }] },
          },
        },
        statusHistory: { bsonType: 'array', maxItems: 50 },
      },
    });

    const orders = db.collection('orders');
    await orders.createIndex({ orderNo: 1 }, { unique: true, name: 'order_no_unique' });
    // The hottest path in the system: a seller working their queue.
    await orders.createIndex({ shopId: 1, status: 1, createdAt: -1 }, { name: 'seller_queue' });
    await orders.createIndex({ buyerId: 1, createdAt: -1 }, { name: 'buyer_history' });
    await orders.createIndex({ groupId: 1 }, { name: 'group_children' });
    await orders.createIndex({ sellerId: 1, status: 1, createdAt: -1 }, { name: 'seller_statement' });
    await orders.createIndex({ marketId: 1, createdAt: -1 }, { name: 'market_reporting' });
    // Timer cursors. Partial, so a one-minute cron reads a handful of rows rather than
    // scanning twenty million orders (DATABASE.md 2.4).
    await orders.createIndex(
      { status: 1, acceptDeadline: 1 },
      { name: 'accept_expiry', partialFilterExpression: { status: 'PENDING' } },
    );
    await orders.createIndex(
      { status: 1, autoCompleteAt: 1 },
      { name: 'auto_complete', partialFilterExpression: { status: 'PICKED_UP' } },
    );
    await orders.createIndex(
      { 'commission.status': 1, createdAt: 1 },
      { name: 'commission_pending', partialFilterExpression: { 'commission.status': 'PENDING' } },
    );

    await ensure(db, 'order_adjustments', {
      bsonType: 'object',
      required: ['orderId', 'orderNo', 'shopId', 'buyerId', 'lines', 'oldTotal', 'newTotal', 'status', 'expiresAt', 'schemaVersion'],
      properties: {
        status: { enum: ['NONE', 'AUTO_APPROVED', 'PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'] },
        oldTotal: { bsonType: 'long', minimum: 0 },
        newTotal: { bsonType: 'long', minimum: 0 },
      },
    });
    await db.collection('order_adjustments').createIndex({ orderId: 1, createdAt: -1 }, { name: 'order_history' });
    await db.collection('order_adjustments').createIndex(
      { status: 1, expiresAt: 1 },
      { name: 'adjustment_timeout', partialFilterExpression: { status: 'PENDING' } },
    );
    // The over-delivery abuse report reads this.
    await db.collection('order_adjustments').createIndex({ shopId: 1, createdAt: -1 }, { name: 'shop_pattern' });

    await ensure(db, 'idempotency_keys', {
      bsonType: 'object',
      required: ['key', 'userId', 'endpoint', 'requestHash', 'state', 'expiresAt'],
      properties: {
        state: { enum: ['IN_PROGRESS', 'COMPLETED'] },
        requestHash: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
      },
    });
    // Scoped per user: two people may generate the same UUID, and one must not receive the
    // other's order.
    await db.collection('idempotency_keys').createIndex({ key: 1, userId: 1 }, { unique: true, name: 'key_user_unique' });
    await db.collection('idempotency_keys').createIndex({ expiresAt: 1 }, { name: 'key_ttl', expireAfterSeconds: 0 });
  },

  async down(db) {
    for (const name of ['idempotency_keys', 'order_adjustments', 'orders', 'order_groups']) {
      const existing = await db.listCollections({ name }).toArray();
      if (existing.length === 0) continue;
      // Relaxed, never dropped: orders are the commercial record of the business.
      await db.command({ collMod: name, validator: {}, validationLevel: 'off' });
      const indexes = await db.collection(name).indexes();
      for (const index of indexes) {
        if (index.name !== '_id_') await db.collection(name).dropIndex(index.name);
      }
    }
  },
};
