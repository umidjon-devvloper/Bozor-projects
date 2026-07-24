/**
 * Media module: collection validator and indexes (ADR-0026).
 *
 * `additionalProperties` is deliberately not set to false here: the module writes several
 * optional fields that only exist after confirmation, and a strict property list would have
 * to be updated in lockstep with every schema addition. The required set and the enums carry
 * the weight instead.
 */
const NAME = 'media_assets';

const validator = {
  $jsonSchema: {
    bsonType: 'object',
    required: [
      'mediaKey', 'ownerId', 'purpose', 'visibility', 'bucket',
      'declaredContentType', 'sizeBytes', 'status', 'expiresAt', 'schemaVersion', 'createdAt',
    ],
    properties: {
      mediaKey: { bsonType: 'string', minLength: 8, maxLength: 256 },
      ownerId: { bsonType: 'objectId' },
      purpose: {
        enum: [
          'PRODUCT_IMAGE', 'SHOP_LOGO', 'SHOP_COVER', 'SHOP_PHOTO', 'MARKET_PHOTO',
          'AVATAR', 'REVIEW_PHOTO', 'KYC_DOCUMENT', 'DISPUTE_EVIDENCE',
        ],
      },
      visibility: { enum: ['PUBLIC', 'PRIVATE'] },
      status: { enum: ['PENDING', 'CONFIRMED', 'ATTACHED', 'ORPHANED', 'REJECTED'] },
      sizeBytes: { bsonType: ['int', 'long'], minimum: 0 },
      variants: {
        bsonType: 'array',
        maxItems: 8,
        items: {
          bsonType: 'object',
          required: ['name', 'key', 'width', 'height', 'sizeBytes', 'contentType'],
          additionalProperties: false,
          properties: {
            name: { bsonType: 'string', maxLength: 32 },
            key: { bsonType: 'string', maxLength: 256 },
            width: { bsonType: ['int', 'long'], minimum: 1 },
            height: { bsonType: ['int', 'long'], minimum: 1 },
            sizeBytes: { bsonType: ['int', 'long'], minimum: 0 },
            contentType: { bsonType: 'string', maxLength: 64 },
          },
        },
      },
      attachedTo: {
        oneOf: [
          {
            bsonType: 'object',
            required: ['type', 'id'],
            additionalProperties: false,
            properties: { type: { bsonType: 'string', maxLength: 32 }, id: { bsonType: 'string' } },
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
      await db.createCollection(NAME, {
        validator,
        validationLevel: 'strict',
        validationAction: 'error',
      });
    } else {
      await db.command({
        collMod: NAME,
        validator,
        validationLevel: 'strict',
        validationAction: 'error',
      });
    }

    const collection = db.collection(NAME);
    await collection.createIndex({ mediaKey: 1 }, { unique: true, name: 'mediakey_unique' });
    await collection.createIndex({ ownerId: 1, createdAt: -1 }, { name: 'owner_recent' });
    await collection.createIndex(
      { ownerId: 1, purpose: 1, createdAt: -1 },
      { name: 'quota_window', partialFilterExpression: { status: { $ne: 'REJECTED' } } },
    );
    // Sweeper cursors. Partial so the 15-minute job touches a handful of rows rather than
    // every asset ever uploaded.
    await collection.createIndex(
      { status: 1, expiresAt: 1 },
      { name: 'pending_expiry', partialFilterExpression: { status: 'PENDING' } },
    );
    await collection.createIndex(
      { status: 1, confirmedAt: 1 },
      { name: 'unattached_sweep', partialFilterExpression: { status: 'CONFIRMED' } },
    );
    await collection.createIndex(
      { 'attachedTo.type': 1, 'attachedTo.id': 1 },
      { name: 'attachment_lookup' },
    );
  },

  async down(db) {
    const existing = await db.listCollections({ name: NAME }).toArray();
    if (existing.length === 0) return;
    // Relax rather than drop: rolling back must not destroy the record of objects that
    // still exist in storage, or reclamation becomes impossible.
    await db.command({ collMod: NAME, validator: {}, validationLevel: 'off' });
    const indexes = await db.collection(NAME).indexes();
    for (const index of indexes) {
      if (index.name !== '_id_') await db.collection(NAME).dropIndex(index.name);
    }
  },
};
