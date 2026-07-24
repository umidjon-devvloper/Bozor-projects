/**
 * Wallet, ledger and commission: validators and indexes (ADR-0026, ADR-0033).
 *
 * `journal_entries` gets the strictest validator in the system. It cannot express "debits
 * equal credits" — `$jsonSchema` has no arithmetic — so that invariant is enforced in the
 * shared domain function every writer calls. What the validator *can* do is guarantee every
 * amount is a positive Int64 on a known account, which removes the ways an unbalanced entry
 * could be constructed in the first place.
 */
const ACCOUNTS = [
  'SELLER_WALLET',
  'PLATFORM_REVENUE_COMMISSION',
  'PLATFORM_CASH',
  'PLATFORM_ADJUSTMENT',
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
    await db.command({ collMod: name, validator: { $jsonSchema: validator }, validationLevel: 'strict', validationAction: 'error' });
  }
}

module.exports = {
  async up(db) {
    await ensure(db, 'wallets', {
      bsonType: 'object',
      required: ['ownerId', 'ownerType', 'balanceMinor', 'currency', 'state', 'schemaVersion'],
      properties: {
        ownerId: { bsonType: 'objectId' },
        ownerType: { enum: ['SELLER'] },
        // No minimum: a commission charge is never refused for lack of funds, so the balance
        // is allowed to go negative and the seller is deactivated instead.
        balanceMinor: { bsonType: 'long' },
        currency: { enum: ['UZS'] },
        state: { enum: ['ACTIVE', 'LOW', 'INACTIVE'] },
        lowBalanceThresholdMinor: { bsonType: 'long' },
        deactivateBelowMinor: { bsonType: 'long' },
        graceHours: { bsonType: ['int', 'long'], minimum: 0, maximum: 720 },
        lifetimeChargedMinor: { bsonType: 'long', minimum: 0 },
        lifetimeCreditedMinor: { bsonType: 'long', minimum: 0 },
      },
    });
    await db.collection('wallets').createIndex({ ownerId: 1 }, { unique: true, name: 'owner_unique' });
    await db.collection('wallets').createIndex(
      { state: 1, belowFloorSince: 1 },
      { name: 'grace_sweep', partialFilterExpression: { state: 'LOW' } },
    );

    await ensure(db, 'journal_entries', {
      bsonType: 'object',
      required: ['entryKey', 'type', 'occurredAt', 'lines', 'totalMinor', 'schemaVersion'],
      properties: {
        entryKey: { bsonType: 'string', minLength: 3, maxLength: 128 },
        type: {
          enum: [
            'COMMISSION_CHARGE', 'COMMISSION_REVERSAL', 'TOP_UP',
            'MANUAL_CREDIT', 'MANUAL_DEBIT', 'OPENING_BALANCE',
          ],
        },
        totalMinor: { bsonType: 'long', minimum: 1 },
        lines: {
          bsonType: 'array',
          minItems: 2,
          maxItems: 20,
          items: {
            bsonType: 'object',
            required: ['account', 'side', 'amountMinor'],
            additionalProperties: false,
            properties: {
              account: { enum: ACCOUNTS },
              side: { enum: ['DEBIT', 'CREDIT'] },
              // Direction is the side, never the sign.
              amountMinor: { bsonType: 'long', minimum: 1 },
              walletId: { oneOf: [{ bsonType: 'objectId' }, { bsonType: 'null' }] },
              ownerId: { oneOf: [{ bsonType: 'objectId' }, { bsonType: 'null' }] },
            },
          },
        },
      },
    });
    // The natural key. This unique index is what makes a redelivered `order.completed`
    // harmless rather than a second charge.
    await db.collection('journal_entries').createIndex({ entryKey: 1 }, { unique: true, name: 'entry_key_unique' });
    await db.collection('journal_entries').createIndex(
      { 'lines.walletId': 1, occurredAt: -1 },
      { name: 'wallet_statement' },
    );
    await db.collection('journal_entries').createIndex({ type: 1, occurredAt: -1 }, { name: 'by_type' });
    await db.collection('journal_entries').createIndex(
      { 'reference.type': 1, 'reference.id': 1 },
      { name: 'by_reference' },
    );
    await db.collection('journal_entries').createIndex({ occurredAt: -1 }, { name: 'chronological' });

    await ensure(db, 'commission_rules', {
      bsonType: 'object',
      required: ['scope', 'percentBp', 'priority', 'effectiveFrom', 'createdBy', 'schemaVersion'],
      properties: {
        scope: { enum: ['SHOP', 'MARKET', 'CATEGORY', 'PLATFORM'] },
        scopeId: { oneOf: [{ bsonType: 'objectId' }, { bsonType: 'null' }] },
        // Basis points. An integer, so a rate can never be 2.9999999999999996.
        percentBp: { bsonType: ['int', 'long'], minimum: 0, maximum: 10000 },
        minChargeMinor: { oneOf: [{ bsonType: 'long', minimum: 0 }, { bsonType: 'null' }] },
        maxChargeMinor: { oneOf: [{ bsonType: 'long', minimum: 0 }, { bsonType: 'null' }] },
        priority: { bsonType: ['int', 'long'], minimum: 0, maximum: 1000 },
      },
    });
    await db.collection('commission_rules').createIndex(
      { scope: 1, scopeId: 1, effectiveFrom: -1 },
      { name: 'resolution' },
    );
    await db.collection('commission_rules').createIndex(
      { effectiveFrom: -1, effectiveTo: 1 },
      { name: 'effective_window' },
    );

    // Deliberately no seeded rule. The rate is a commercial decision entered through the
    // administrative API, and inventing one here would be worse than having none (ADR-0033).
  },

  async down(db) {
    for (const name of ['commission_rules', 'journal_entries', 'wallets']) {
      const existing = await db.listCollections({ name }).toArray();
      if (existing.length === 0) continue;
      // Relaxed, never dropped. The journal is the financial record of the business, and a
      // rollback that destroys it is not a rollback.
      await db.command({ collMod: name, validator: {}, validationLevel: 'off' });
      const indexes = await db.collection(name).indexes();
      for (const index of indexes) {
        if (index.name !== '_id_') await db.collection(name).dropIndex(index.name);
      }
    }
  },
};
