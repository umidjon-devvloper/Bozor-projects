/**
 * Reviews: validator, indexes, and the rating-sum backfill (ADR-0026).
 *
 * `ratingSum` is added to products and shops so that adding a review is a single atomic
 * pipeline update rather than read-modify-write. It is backfilled from the existing average
 * and count, which is exact: `avg * count` is the sum those two were derived from.
 */
const NAME = 'reviews';

const validator = {
  $jsonSchema: {
    bsonType: 'object',
    required: [
      'orderId', 'orderNo', 'productId', 'shopId', 'buyerId',
      'buyerName', 'rating', 'status', 'schemaVersion', 'createdAt',
    ],
    properties: {
      orderId: { bsonType: 'objectId' },
      productId: { bsonType: 'objectId' },
      shopId: { bsonType: 'objectId' },
      buyerId: { bsonType: 'objectId' },
      buyerName: { bsonType: 'string', minLength: 1, maxLength: 120 },
      // Whole stars only. A fractional rating would break the exact integer aggregate.
      rating: { bsonType: ['int', 'long'], minimum: 1, maximum: 5 },
      comment: { oneOf: [{ bsonType: 'string', maxLength: 2000 }, { bsonType: 'null' }] },
      status: { enum: ['PUBLISHED', 'REPORTED', 'HIDDEN', 'WITHDRAWN'] },
      photos: { bsonType: 'array', maxItems: 5 },
      reports: {
        bsonType: 'array',
        maxItems: 50,
        items: {
          bsonType: 'object',
          required: ['userId', 'reason', 'at'],
          properties: {
            userId: { bsonType: 'objectId' },
            reason: { enum: ['OFFENSIVE', 'SPAM', 'IRRELEVANT', 'PERSONAL_DATA', 'FAKE', 'OTHER'] },
          },
        },
      },
      sellerReply: {
        oneOf: [
          {
            bsonType: 'object',
            required: ['text', 'at', 'by'],
            additionalProperties: false,
            properties: {
              text: { bsonType: 'string', minLength: 1, maxLength: 1000 },
              at: { bsonType: 'date' },
              by: { bsonType: 'objectId' },
            },
          },
          { bsonType: 'null' },
        ],
      },
    },
  },
};

module.exports = {
  async up(db) {
    const existing = await db.listCollections({ name: NAME }).toArray();
    if (existing.length === 0) {
      await db.createCollection(NAME, { validator, validationLevel: 'strict', validationAction: 'error' });
    } else {
      await db.command({ collMod: NAME, validator, validationLevel: 'strict', validationAction: 'error' });
    }

    const reviews = db.collection(NAME);
    // One review per product per order: buying the same tomatoes twice earns two reviews,
    // buying them once does not.
    await reviews.createIndex({ orderId: 1, productId: 1 }, { unique: true, name: 'one_per_order_line' });
    await reviews.createIndex({ productId: 1, status: 1, createdAt: -1 }, { name: 'product_reviews' });
    await reviews.createIndex({ shopId: 1, status: 1, createdAt: -1 }, { name: 'shop_reviews' });
    await reviews.createIndex({ buyerId: 1, createdAt: -1 }, { name: 'buyer_history' });
    await reviews.createIndex(
      { status: 1, createdAt: 1 },
      { name: 'moderation_queue', partialFilterExpression: { status: 'REPORTED' } },
    );
    await reviews.createIndex(
      { shopId: 1, createdAt: -1 },
      { name: 'awaiting_reply', partialFilterExpression: { sellerReply: null } },
    );

    // Backfill the exact sum. `avg * count` reconstructs it precisely, because that is the
    // arithmetic the stored average came from.
    for (const collection of ['products', 'shops']) {
      await db.collection(collection).updateMany({ ratingSum: { $exists: false } }, [
        {
          $set: {
            ratingSum: {
              $multiply: [{ $ifNull: ['$ratingAvg', 0] }, { $ifNull: ['$ratingCount', 0] }],
            },
          },
        },
      ]);
    }
  },

  async down(db) {
    const existing = await db.listCollections({ name: NAME }).toArray();
    if (existing.length === 0) return;
    // Relaxed, never dropped: reviews are the sellers' public reputation and cannot be
    // recreated once lost.
    await db.command({ collMod: NAME, validator: {}, validationLevel: 'off' });
    const indexes = await db.collection(NAME).indexes();
    for (const index of indexes) {
      if (index.name !== '_id_') await db.collection(NAME).dropIndex(index.name);
    }
  },
};
