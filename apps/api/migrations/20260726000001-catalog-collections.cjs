/**
 * Catalog module: collection validators and indexes (ADR-0026).
 *
 * The money and quantity fields are declared `long` here, not `number`. That is the point of
 * the migration: Mongoose casts BigInt correctly, but a migration script or an operator
 * writing through mongosh could store a double, and a double price is exactly the drift
 * ADR-0004 exists to prevent.
 */
const localizedText = {
  bsonType: 'object',
  required: ['uz'],
  properties: {
    uz: { bsonType: 'string', minLength: 1, maxLength: 2000 },
    uzCyrl: { bsonType: 'string', maxLength: 2000 },
    ru: { bsonType: 'string', maxLength: 2000 },
    en: { bsonType: 'string', maxLength: 2000 },
  },
};

async function ensure(db, name, validator, options = {}) {
  const existing = await db.listCollections({ name }).toArray();
  if (existing.length === 0) {
    await db.createCollection(name, {
      ...options,
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
    await ensure(db, 'units', {
      bsonType: 'object',
      required: ['code', 'name', 'shortName', 'decimalPlaces', 'allowsAdjustment', 'schemaVersion'],
      properties: {
        code: { bsonType: 'string', minLength: 1, maxLength: 16 },
        name: localizedText,
        shortName: localizedText,
        decimalPlaces: { bsonType: ['int', 'long'], minimum: 0, maximum: 3 },
        allowsAdjustment: { bsonType: 'bool' },
      },
    });
    await db.collection('units').createIndex({ code: 1 }, { unique: true, name: 'code_unique' });
    await db.collection('units').createIndex({ order: 1 }, { name: 'order_asc' });

    await ensure(db, 'categories', {
      bsonType: 'object',
      required: ['slug', 'name', 'depth', 'defaultUnit', 'allowedUnits', 'isActive', 'schemaVersion'],
      properties: {
        parentId: { oneOf: [{ bsonType: 'objectId' }, { bsonType: 'null' }] },
        slug: { bsonType: 'string', minLength: 1, maxLength: 120 },
        name: localizedText,
        depth: { bsonType: ['int', 'long'], minimum: 0, maximum: 3 },
        defaultUnit: { bsonType: 'string', maxLength: 16 },
        allowedUnits: { bsonType: 'array', minItems: 1, maxItems: 10, items: { bsonType: 'string' } },
        defaultTolerancePercent: { bsonType: ['int', 'long'], minimum: 0, maximum: 5000 },
        ancestors: {
          bsonType: 'array',
          maxItems: 3,
          items: {
            bsonType: 'object',
            required: ['_id', 'slug', 'name'],
            additionalProperties: false,
            properties: { _id: { bsonType: 'objectId' }, slug: { bsonType: 'string' }, name: localizedText },
          },
        },
      },
    });
    await db.collection('categories').createIndex({ slug: 1 }, { unique: true, name: 'slug_unique' });
    await db.collection('categories').createIndex({ parentId: 1, order: 1 }, { name: 'parent_order' });
    await db
      .collection('categories')
      .createIndex({ 'ancestors._id': 1, isActive: 1 }, { name: 'subtree_lookup' });
    await db
      .collection('categories')
      .createIndex({ isActive: 1, depth: 1, order: 1 }, { name: 'tree_render' });

    await ensure(db, 'products', {
      bsonType: 'object',
      required: [
        'shopId', 'marketId', 'categoryId', 'categoryPath', 'name', 'images', 'unit',
        'price', 'stockQtyMilli', 'reservedQtyMilli', 'minOrderQtyMilli', 'stepQtyMilli',
        'tolerancePercent', 'status', 'moderationStatus', 'isVisible', 'slug', 'schemaVersion',
      ],
      properties: {
        shopId: { bsonType: 'objectId' },
        categoryId: { bsonType: 'objectId' },
        categoryPath: { bsonType: 'array', minItems: 1, maxItems: 4, items: { bsonType: 'objectId' } },
        name: localizedText,
        slug: { bsonType: 'string', minLength: 1, maxLength: 160 },
        unit: { bsonType: 'string', maxLength: 16 },
        images: { bsonType: 'array', minItems: 1, maxItems: 10 },
        // Int64 only. A double here silently loses tiyin at scale.
        price: { bsonType: 'long', minimum: 1 },
        oldPrice: { oneOf: [{ bsonType: 'long', minimum: 1 }, { bsonType: 'null' }] },
        stockQtyMilli: { bsonType: 'long', minimum: 0 },
        reservedQtyMilli: { bsonType: 'long', minimum: 0 },
        minOrderQtyMilli: { bsonType: 'long', minimum: 1 },
        stepQtyMilli: { bsonType: 'long', minimum: 1 },
        maxOrderQtyMilli: { oneOf: [{ bsonType: 'long', minimum: 1 }, { bsonType: 'null' }] },
        soldQtyMilli: { bsonType: 'long', minimum: 0 },
        tolerancePercent: { bsonType: ['int', 'long'], minimum: 0, maximum: 5000 },
        status: { enum: ['DRAFT', 'PENDING_MODERATION', 'ACTIVE', 'OUT_OF_STOCK', 'ARCHIVED'] },
        moderationStatus: { enum: ['PENDING', 'APPROVED', 'REJECTED'] },
        isVisible: { bsonType: 'bool' },
        shopVisible: { bsonType: 'bool' },
      },
    });

    const products = db.collection('products');
    await products.createIndex({ slug: 1 }, { unique: true, name: 'slug_unique' });
    await products.createIndex(
      { shopId: 1, status: 1, createdAt: -1 },
      { name: 'seller_dashboard', partialFilterExpression: { deletedAt: null } },
    );
    await products.createIndex(
      { shopId: 1, isVisible: 1, createdAt: -1, _id: -1 },
      { name: 'shop_page' },
    );
    await products.createIndex({ categoryId: 1, isVisible: 1, price: 1, _id: 1 }, { name: 'category_price' });
    await products.createIndex(
      { categoryPath: 1, isVisible: 1, ratingBayesian: -1, _id: -1 },
      { name: 'subtree_ranked' },
    );
    await products.createIndex(
      { marketId: 1, isVisible: 1, salesCount: -1, _id: -1 },
      { name: 'market_bestsellers' },
    );
    await products.createIndex({ isVisible: 1, updatedAt: -1 }, { name: 'indexer_cursor' });
    await products.createIndex({ shopId: 1, deletedAt: 1 }, { name: 'shop_cascade' });
    await products.createIndex(
      { moderationStatus: 1, createdAt: 1 },
      { name: 'moderation_queue', partialFilterExpression: { moderationStatus: 'PENDING' } },
    );
    await products.createIndex(
      { status: 1, stockQtyMilli: 1 },
      { name: 'restock_sweep', partialFilterExpression: { status: 'OUT_OF_STOCK' } },
    );

    // Time-series (ADR-0027). Created without a $jsonSchema validator: time-series
    // collections do not accept collMod validators, and their shape is fixed by the driver.
    const existing = await db.listCollections({ name: 'product_price_history' }).toArray();
    if (existing.length === 0) {
      await db.createCollection('product_price_history', {
        timeseries: { timeField: 'changedAt', metaField: 'meta', granularity: 'hours' },
        expireAfterSeconds: 60 * 60 * 24 * 730,
      });
    }
  },

  async down(db) {
    for (const name of ['products', 'categories', 'units']) {
      const existing = await db.listCollections({ name }).toArray();
      if (existing.length === 0) continue;
      // Relax rather than drop: a rollback must never destroy a seller's catalogue.
      await db.command({ collMod: name, validator: {}, validationLevel: 'off' });
      const indexes = await db.collection(name).indexes();
      for (const index of indexes) {
        if (index.name !== '_id_') await db.collection(name).dropIndex(index.name);
      }
    }
  },
};
