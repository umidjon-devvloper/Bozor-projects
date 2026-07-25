/**
 * Payment transactions (PAYMENT_SYSTEM.md).
 *
 * The unique index on (provider, providerTransactionId) is the module's central invariant.
 * Both Payme and Click retry every callback by design — Payme's documentation states that each
 * request is sent twice on purpose — so a second row for the same provider transaction would
 * mean a wallet credited twice the first time anybody paid. The database enforces it, not a
 * service that could race with itself.
 */
module.exports = {
  async up(db) {
    await db.createCollection('payment_transactions', {
      validator: {
        $jsonSchema: {
          bsonType: 'object',
          required: [
            'provider',
            'providerTransactionId',
            'purpose',
            'ownerId',
            'amountMinor',
            'state',
            'schemaVersion',
          ],
          properties: {
            provider: { enum: ['PAYME', 'CLICK'] },
            providerTransactionId: { bsonType: 'string', maxLength: 64 },
            providerReference: { bsonType: ['string', 'null'] },
            purpose: { enum: ['SELLER_TOPUP'] },
            ownerId: { bsonType: 'objectId' },
            // Int64 tiyin (ADR-0004). Payme sends tiyin; Click sends decimal som and the
            // conversion refuses anything finer than a tiyin rather than rounding it.
            amountMinor: { bsonType: 'long' },
            // Payme's own state integers, used for both providers: 1, 2, -1, -2.
            state: { bsonType: 'int' },
            reason: { bsonType: ['int', 'null'] },
            journalEntryId: { bsonType: ['objectId', 'null'] },
            performedAt: { bsonType: ['date', 'null'] },
            cancelledAt: { bsonType: ['date', 'null'] },
            schemaVersion: { bsonType: 'int' },
          },
        },
      },
      validationLevel: 'strict',
      validationAction: 'error',
    });

    await db.collection('payment_transactions').createIndexes([
      {
        key: { provider: 1, providerTransactionId: 1 },
        name: 'uniq_provider_transaction',
        unique: true,
      },
      { key: { ownerId: 1, createdAt: -1 }, name: 'owner_history' },
      { key: { state: 1, createdAt: 1 }, name: 'timeout_sweeper' },
    ]);
  },

  async down(db) {
    await db.collection('payment_transactions').drop();
  },
};
