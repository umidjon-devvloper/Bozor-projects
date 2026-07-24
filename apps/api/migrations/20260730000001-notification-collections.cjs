/**
 * Notifications: validators and indexes (ADR-0026).
 *
 * The `dedupeKey` unique index is the load-bearing one. Every handler derives it from the
 * event id, so a redelivery from the outbox relay loses the insert and sends nothing — which
 * is the whole reason at-least-once delivery is safe here.
 */
const CATEGORIES = ['ORDER', 'WALLET', 'MODERATION', 'ACCOUNT', 'MARKETING'];
const CHANNELS = ['PUSH', 'SMS', 'IN_APP'];

async function ensure(db, name, validator) {
  const existing = await db.listCollections({ name }).toArray();
  if (existing.length === 0) {
    await db.createCollection(name, {
      validator: { $jsonSchema: validator },
      validationLevel: 'strict',
      validationAction: 'error',
    });
  } else {
    await db.command({ collMod: name, validator: { $jsonSchema: validator }, validationLevel: 'strict', validationAction: 'error' });
  }
}

module.exports = {
  async up(db) {
    await ensure(db, 'notifications', {
      bsonType: 'object',
      required: ['dedupeKey', 'userId', 'category', 'type', 'title', 'body', 'locale', 'schemaVersion'],
      properties: {
        dedupeKey: { bsonType: 'string', minLength: 3, maxLength: 160 },
        userId: { bsonType: 'objectId' },
        category: { enum: CATEGORIES },
        type: { bsonType: 'string', maxLength: 64 },
        title: { bsonType: 'string', minLength: 1, maxLength: 120 },
        body: { bsonType: 'string', minLength: 1, maxLength: 400 },
        attempts: {
          bsonType: 'array',
          maxItems: 20,
          items: {
            bsonType: 'object',
            required: ['channel', 'status', 'attemptedAt'],
            properties: {
              channel: { enum: CHANNELS },
              status: { enum: ['PENDING', 'SENT', 'DELIVERED', 'FAILED', 'SUPPRESSED'] },
              suppressionReason: {
                oneOf: [
                  { enum: ['OPTED_OUT', 'QUIET_HOURS', 'NO_DEVICE', 'NO_PHONE', 'DUPLICATE'] },
                  { bsonType: 'null' },
                ],
              },
            },
          },
        },
      },
    });
    const notifications = db.collection('notifications');
    await notifications.createIndex({ dedupeKey: 1 }, { unique: true, name: 'dedupe_unique' });
    await notifications.createIndex({ userId: 1, createdAt: -1 }, { name: 'inbox' });
    // The unread badge is polled constantly; a partial index keeps it tiny.
    await notifications.createIndex(
      { userId: 1, readAt: 1 },
      { name: 'unread_badge', partialFilterExpression: { readAt: null } },
    );
    await notifications.createIndex(
      { createdAt: 1 },
      { name: 'retention', expireAfterSeconds: 60 * 60 * 24 * 90 },
    );

    await ensure(db, 'notification_preferences', {
      bsonType: 'object',
      required: ['userId', 'timezone', 'schemaVersion'],
      properties: {
        userId: { bsonType: 'objectId' },
        timezone: { bsonType: 'string', maxLength: 64 },
        channels: {
          bsonType: 'array',
          maxItems: 30,
          items: {
            bsonType: 'object',
            required: ['category', 'channel', 'enabled'],
            additionalProperties: false,
            properties: {
              category: { enum: CATEGORIES },
              channel: { enum: CHANNELS },
              enabled: { bsonType: 'bool' },
            },
          },
        },
      },
    });
    await db
      .collection('notification_preferences')
      .createIndex({ userId: 1 }, { unique: true, name: 'user_unique' });

    // `devices.invalidationReason` is written when a provider retires a token. The field is
    // additive; the existing partial index on `invalidatedAt` already excludes retired
    // devices from every fan-out.
    await db.collection('devices').updateMany(
      { invalidationReason: { $exists: false } },
      { $set: { invalidationReason: null } },
    );
  },

  async down(db) {
    for (const name of ['notification_preferences', 'notifications']) {
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
