/**
 * Disputes: validator and indexes (ADR-0026).
 *
 * The partial unique index on `orderId` is the load-bearing one: one live dispute per order,
 * while leaving a settled one able to be followed by a second, genuinely different claim.
 */
const NAME = 'disputes';
const ACTIVE = ['OPEN', 'UNDER_REVIEW'];

const validator = {
  $jsonSchema: {
    bsonType: 'object',
    required: [
      'disputeNo', 'orderId', 'orderNo', 'buyerId', 'sellerId', 'shopId',
      'reason', 'claim', 'orderTotalMinor', 'status', 'sellerResponseDeadline', 'schemaVersion',
    ],
    properties: {
      disputeNo: { bsonType: 'string', pattern: '^DSP-[0-9]{6}-[A-Z0-9]{6}$' },
      orderId: { bsonType: 'objectId' },
      buyerId: { bsonType: 'objectId' },
      sellerId: { bsonType: 'objectId' },
      shopId: { bsonType: 'objectId' },
      reason: {
        enum: ['NOT_RECEIVED', 'WRONG_ITEM', 'SHORT_WEIGHT', 'POOR_QUALITY', 'SPOILED', 'OVERCHARGED', 'OTHER'],
      },
      // A moderator has to arbitrate between two people; "bad" is not something anyone can
      // decide on.
      claim: { bsonType: 'string', minLength: 10, maxLength: 2000 },
      claimedAmountMinor: { oneOf: [{ bsonType: 'long', minimum: 0 }, { bsonType: 'null' }] },
      orderTotalMinor: { bsonType: 'long', minimum: 0 },
      status: { enum: ['OPEN', 'UNDER_REVIEW', 'RESOLVED_BUYER', 'RESOLVED_SELLER', 'WITHDRAWN'] },
      messages: { bsonType: 'array', maxItems: 100 },
      evidence: { bsonType: 'array', maxItems: 16 },
      resolution: {
        oneOf: [
          {
            bsonType: 'object',
            required: ['outcome', 'refundAmountMinor', 'commissionReversedMinor', 'settlementMethod', 'reason', 'decidedBy', 'decidedAt'],
            additionalProperties: false,
            properties: {
              outcome: { enum: ['REFUND_FULL', 'REFUND_PARTIAL', 'NO_REFUND'] },
              refundAmountMinor: { bsonType: 'long', minimum: 0 },
              commissionReversedMinor: { bsonType: 'long', minimum: 0 },
              settlementMethod: { enum: ['SELLER_DIRECT', 'PAYMENT_GATEWAY'] },
              // Shown to both parties and kept for years; one word is not a decision.
              reason: { bsonType: 'string', minLength: 10, maxLength: 1000 },
              decidedBy: { bsonType: 'objectId' },
              decidedAt: { bsonType: 'date' },
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

    const disputes = db.collection(NAME);
    await disputes.createIndex({ disputeNo: 1 }, { unique: true, name: 'dispute_no_unique' });
    await disputes.createIndex(
      { orderId: 1 },
      { name: 'one_live_per_order', unique: true, partialFilterExpression: { status: { $in: ACTIVE } } },
    );
    await disputes.createIndex({ buyerId: 1, createdAt: -1 }, { name: 'buyer_history' });
    await disputes.createIndex({ shopId: 1, createdAt: -1 }, { name: 'shop_history' });
    await disputes.createIndex(
      { status: 1, createdAt: 1 },
      { name: 'arbitration_queue', partialFilterExpression: { status: { $in: ACTIVE } } },
    );
    // The sweeper that moves an ignored dispute along without the seller.
    await disputes.createIndex(
      { status: 1, sellerResponseDeadline: 1 },
      { name: 'response_timeout', partialFilterExpression: { status: 'OPEN' } },
    );
    await disputes.createIndex({ assignedTo: 1, status: 1 }, { name: 'moderator_workload' });
  },

  async down(db) {
    const existing = await db.listCollections({ name: NAME }).toArray();
    if (existing.length === 0) return;
    // Relaxed, never dropped: a dispute is the evidentiary record behind a refund decision and
    // the only account of why money moved.
    await db.command({ collMod: NAME, validator: {}, validationLevel: 'off' });
    const indexes = await db.collection(NAME).indexes();
    for (const index of indexes) {
      if (index.name !== '_id_') await db.collection(NAME).dropIndex(index.name);
    }
  },
};
