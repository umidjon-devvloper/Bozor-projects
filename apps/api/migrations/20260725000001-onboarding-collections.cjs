/**
 * Onboarding module: collection validator and indexes (ADR-0026).
 *
 * The identity fields are `required` here as well as in Mongoose. A migration script or an
 * operator writing through mongosh must not be able to create an application whose passport
 * data is missing — the blind indexes are the duplicate-identity control, and an application
 * without them would bypass it silently.
 */
const NAME = 'seller_applications';

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

const STATUSES = ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'WITHDRAWN'];
const ACTIVE = ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW'];

const validator = {
  $jsonSchema: {
    bsonType: 'object',
    required: [
      'userId', 'marketId', 'shopName', 'contactPhone',
      'passportSeriesEncrypted', 'passportNumberEncrypted', 'passportBlindIndex',
      'stirEncrypted', 'stirBlindIndex',
      'status', 'resubmissionCount', 'schemaVersion', 'createdAt',
    ],
    properties: {
      userId: { bsonType: 'objectId' },
      marketId: { bsonType: 'objectId' },
      shopName: localizedText,
      contactPhone: { bsonType: 'string', pattern: '^\\+998[0-9]{9}$' },
      // Ciphertext envelopes: `v<n>:<iv>:<tag>:<data>`. The pattern makes it impossible to
      // store a plaintext passport number in a field that is supposed to be encrypted.
      passportSeriesEncrypted: { bsonType: 'string', pattern: '^v[0-9]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$' },
      passportNumberEncrypted: { bsonType: 'string', pattern: '^v[0-9]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$' },
      stirEncrypted: { bsonType: 'string', pattern: '^v[0-9]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$' },
      passportBlindIndex: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
      stirBlindIndex: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
      status: { enum: STATUSES },
      resubmissionCount: { bsonType: ['int', 'long'], minimum: 0, maximum: 10 },
      documents: {
        bsonType: 'array',
        maxItems: 10,
        items: {
          bsonType: 'object',
          required: ['type', 'mediaKey', 'uploadedAt'],
          additionalProperties: false,
          properties: {
            type: { enum: ['PASSPORT', 'STIR_CERTIFICATE', 'MARKET_CONTRACT', 'SHOP_PHOTO'] },
            mediaKey: { bsonType: 'string', maxLength: 256 },
            uploadedAt: { bsonType: 'date' },
          },
        },
      },
      statusHistory: { bsonType: 'array', maxItems: 50 },
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
      await db.command({ collMod: NAME, validator, validationLevel: 'strict', validationAction: 'error' });
    }

    const collection = db.collection(NAME);

    // One live application per user; a settled one must not block a genuine second attempt.
    await collection.createIndex(
      { userId: 1 },
      { name: 'one_active_per_user', unique: true, partialFilterExpression: { status: { $in: ACTIVE } } },
    );
    // The duplicate-identity control. Unique only over approved rows, so a rejected attempt
    // cannot lock a legitimate applicant out of their own passport.
    await collection.createIndex(
      { passportBlindIndex: 1 },
      { name: 'unique_approved_passport', unique: true, partialFilterExpression: { status: 'APPROVED' } },
    );
    await collection.createIndex(
      { stirBlindIndex: 1 },
      { name: 'unique_approved_stir', unique: true, partialFilterExpression: { status: 'APPROVED' } },
    );
    // Moderation queue, oldest first, partial so it stays small.
    await collection.createIndex(
      { status: 1, submittedAt: 1 },
      { name: 'moderation_queue', partialFilterExpression: { status: { $in: ['SUBMITTED', 'UNDER_REVIEW'] } } },
    );
    await collection.createIndex({ userId: 1, createdAt: -1 }, { name: 'user_history' });
    await collection.createIndex({ marketId: 1, status: 1 }, { name: 'market_status' });
    await collection.createIndex({ reviewerId: 1, reviewedAt: -1 }, { name: 'reviewer_throughput' });
  },

  async down(db) {
    const existing = await db.listCollections({ name: NAME }).toArray();
    if (existing.length === 0) return;
    // Relaxed, never dropped: these documents are the evidentiary record behind every
    // approval decision and are retained for the statutory period (COMPLIANCE.md).
    await db.command({ collMod: NAME, validator: {}, validationLevel: 'off' });
    const indexes = await db.collection(NAME).indexes();
    for (const index of indexes) {
      if (index.name !== '_id_') await db.collection(NAME).dropIndex(index.name);
    }
  },
};
