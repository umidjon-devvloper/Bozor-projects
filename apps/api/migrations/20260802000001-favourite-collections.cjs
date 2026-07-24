/**
 * Favourites (FAVORITES_SYSTEM.md).
 *
 * The unique index on (userId, targetType, targetId) is the module's central invariant: it is
 * what makes adding a favourite idempotent rather than duplicable, and it is enforced by the
 * database rather than by the service, because a race between two taps is exactly the case a
 * service-level check would miss.
 */
module.exports = {
  async up(db) {
    await db.createCollection('favourites', {
      validator: {
        $jsonSchema: {
          bsonType: 'object',
          required: ['userId', 'targetType', 'targetId', 'wasPurchasable', 'alertsEnabled', 'schemaVersion'],
          properties: {
            userId: { bsonType: 'objectId' },
            targetType: { enum: ['PRODUCT', 'SHOP'] },
            targetId: { bsonType: 'objectId' },
            shopId: { bsonType: ['objectId', 'null'] },
            // Int64 tiyin, never a double (ADR-0004).
            priceWatermarkMinor: { bsonType: ['long', 'null'] },
            wasPurchasable: { bsonType: 'bool' },
            lastPriceAlertAt: { bsonType: ['date', 'null'] },
            lastRestockAlertAt: { bsonType: ['date', 'null'] },
            alertsEnabled: { bsonType: 'bool' },
            schemaVersion: { bsonType: 'int' },
          },
        },
      },
      validationLevel: 'strict',
      validationAction: 'error',
    });

    await db.collection('favourites').createIndexes([
      { key: { userId: 1, targetType: 1, targetId: 1 }, name: 'uniq_user_target', unique: true },
      { key: { userId: 1, targetType: 1, createdAt: -1 }, name: 'user_list' },
      {
        key: { targetId: 1, targetType: 1, _id: 1 },
        name: 'fanout_followers',
        partialFilterExpression: { alertsEnabled: true },
      },
      {
        key: { shopId: 1, targetType: 1 },
        name: 'shop_followers',
        partialFilterExpression: { shopId: { $type: 'objectId' } },
      },
    ]);
  },

  async down(db) {
    await db.collection('favourites').drop();
  },
};
