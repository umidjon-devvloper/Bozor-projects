/**
 * Geo module: collection validators and indexes.
 *
 * ADR-0026 requires a third validation layer inside MongoDB itself. Mongoose rules are
 * bypassed by migration scripts, mongosh, and any service written later; the collection
 * validator is not.
 */

const point = {
  bsonType: 'object',
  required: ['type', 'coordinates'],
  additionalProperties: false,
  properties: {
    type: { enum: ['Point'] },
    coordinates: { bsonType: 'array', minItems: 2, maxItems: 2, items: { bsonType: 'double' } },
  },
};

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

const workingHours = {
  bsonType: 'array',
  minItems: 7,
  maxItems: 7,
  items: {
    bsonType: 'object',
    required: ['weekday', 'opensAt', 'closesAt', 'isClosed'],
    additionalProperties: false,
    properties: {
      weekday: { bsonType: 'int', minimum: 0, maximum: 6 },
      opensAt: { bsonType: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' },
      closesAt: { bsonType: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' },
      isClosed: { bsonType: 'bool' },
    },
  },
};

async function ensureCollection(db, name, validator) {
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
    await ensureCollection(db, 'regions', {
      bsonType: 'object',
      required: ['code', 'name', 'center', 'order', 'isActive', 'schemaVersion', 'createdAt'],
      properties: {
        code: { bsonType: 'string', minLength: 2, maxLength: 8 },
        name: localizedText,
        center: point,
        order: { bsonType: 'int' },
        isActive: { bsonType: 'bool' },
        districtCount: { bsonType: 'int', minimum: 0 },
      },
    });
    await db.collection('regions').createIndex({ code: 1 }, { unique: true, name: 'code_unique' });
    await db.collection('regions').createIndex({ order: 1 }, { name: 'order_asc' });

    await ensureCollection(db, 'districts', {
      bsonType: 'object',
      required: ['regionId', 'code', 'name', 'isCity', 'order', 'isActive', 'schemaVersion'],
      properties: {
        regionId: { bsonType: 'objectId' },
        code: { bsonType: 'string', minLength: 2, maxLength: 12 },
        name: localizedText,
        center: { oneOf: [point, { bsonType: 'null' }] },
        isCity: { bsonType: 'bool' },
        marketCount: { bsonType: 'int', minimum: 0 },
      },
    });
    await db.collection('districts').createIndex({ code: 1 }, { unique: true, name: 'code_unique' });
    await db
      .collection('districts')
      .createIndex({ regionId: 1, order: 1 }, { name: 'region_order' });

    await ensureCollection(db, 'markets', {
      bsonType: 'object',
      required: [
        'districtId', 'regionId', 'name', 'slug', 'location', 'address',
        'workingHours', 'timezone', 'status', 'schemaVersion',
      ],
      properties: {
        districtId: { bsonType: 'objectId' },
        regionId: { bsonType: 'objectId' },
        name: localizedText,
        slug: { bsonType: 'string', minLength: 1, maxLength: 120 },
        location: point,
        address: localizedText,
        workingHours,
        timezone: { bsonType: 'string', maxLength: 64 },
        status: { enum: ['ACTIVE', 'TEMPORARILY_CLOSED', 'ARCHIVED'] },
        shopCount: { bsonType: 'int', minimum: 0 },
        productCount: { bsonType: 'int', minimum: 0 },
      },
    });
    await db.collection('markets').createIndex({ location: '2dsphere' }, { name: 'location_2dsphere' });
    await db.collection('markets').createIndex({ slug: 1 }, { unique: true, name: 'slug_unique' });
    await db.collection('markets').createIndex({ districtId: 1, status: 1 }, { name: 'district_status' });
    await db.collection('markets').createIndex({ regionId: 1, status: 1 }, { name: 'region_status' });
    await db
      .collection('markets')
      .createIndex({ status: 1, shopCount: -1, _id: -1 }, { name: 'status_shopcount_id' });

    await ensureCollection(db, 'shops', {
      bsonType: 'object',
      required: [
        'ownerId', 'marketId', 'districtId', 'regionId', 'name', 'slug', 'contactPhone',
        'members', 'workingHours', 'timezone', 'status', 'moderationStatus',
        'sellerWalletActive', 'isVisible', 'schemaVersion',
      ],
      properties: {
        ownerId: { bsonType: 'objectId' },
        marketId: { bsonType: 'objectId' },
        name: localizedText,
        slug: { bsonType: 'string', minLength: 1, maxLength: 140 },
        contactPhone: { bsonType: 'string', pattern: '^\\+998[0-9]{9}$' },
        members: {
          bsonType: 'array',
          minItems: 1,
          maxItems: 20,
          items: {
            bsonType: 'object',
            required: ['userId', 'role', 'addedAt', 'addedBy'],
            additionalProperties: false,
            properties: {
              userId: { bsonType: 'objectId' },
              role: { enum: ['OWNER', 'MANAGER', 'STAFF'] },
              addedAt: { bsonType: 'date' },
              addedBy: { bsonType: 'objectId' },
            },
          },
        },
        workingHours,
        status: { enum: ['DRAFT', 'ACTIVE', 'SUSPENDED', 'CLOSED'] },
        moderationStatus: { enum: ['PENDING', 'APPROVED', 'REJECTED'] },
        sellerWalletActive: { bsonType: 'bool' },
        isVisible: { bsonType: 'bool' },
        ratingAvg: { bsonType: 'int', minimum: 0, maximum: 500 },
        ratingBayesian: { bsonType: 'int', minimum: 0, maximum: 500 },
      },
    });
    await db.collection('shops').createIndex({ slug: 1 }, { unique: true, name: 'slug_unique' });
    await db
      .collection('shops')
      .createIndex({ ownerId: 1 }, { name: 'owner', partialFilterExpression: { deletedAt: null } });
    await db
      .collection('shops')
      .createIndex(
        { marketId: 1, isVisible: 1, ratingBayesian: -1, _id: -1 },
        { name: 'market_visible_rating' },
      );
    await db
      .collection('shops')
      .createIndex(
        { marketId: 1, isVisible: 1, createdAt: -1, _id: -1 },
        { name: 'market_visible_created' },
      );
    await db.collection('shops').createIndex({ 'members.userId': 1 }, { name: 'member_lookup' });
    await db.collection('shops').createIndex({ isVisible: 1, updatedAt: -1 }, { name: 'indexer_cursor' });
    await db.collection('shops').createIndex(
      { moderationStatus: 1, createdAt: 1 },
      { name: 'moderation_queue', partialFilterExpression: { moderationStatus: 'PENDING' } },
    );
    await db
      .collection('shops')
      .createIndex({ location: '2dsphere' }, { name: 'location_2dsphere', sparse: true });
  },

  async down(db) {
    for (const name of ['shops', 'markets', 'districts', 'regions']) {
      const existing = await db.listCollections({ name }).toArray();
      if (existing.length === 0) continue;
      // Relax the validator rather than dropping data: a rollback must never destroy
      // markets or shops that were created while the migration was applied.
      await db.command({ collMod: name, validator: {}, validationLevel: 'off' });
      const indexes = await db.collection(name).indexes();
      for (const index of indexes) {
        if (index.name !== '_id_') await db.collection(name).dropIndex(index.name);
      }
    }
  },
};
