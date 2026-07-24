import { Schema, model, type Model, type Types } from 'mongoose';

/**
 * Idempotency records for unsafe money endpoints (API.md 1.11).
 *
 * `requestHash` is what makes this more than a replay cache. Returning the stored response
 * for the same key with a *different* body would silently discard a real, distinct request —
 * so that case is an error, not a cache hit.
 */
export interface IdempotencyKeyDoc {
  _id: Types.ObjectId;
  key: string;
  userId: Types.ObjectId;
  endpoint: string;
  requestHash: string;
  state: 'IN_PROGRESS' | 'COMPLETED';
  responseStatus: number | null;
  responseBody: Record<string, unknown> | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const idempotencyKeySchema = new Schema<IdempotencyKeyDoc>(
  {
    key: { type: String, required: true, maxlength: 128 },
    userId: { type: Schema.Types.ObjectId, required: true },
    endpoint: { type: String, required: true, maxlength: 128 },
    requestHash: { type: String, required: true, maxlength: 64 },
    state: { type: String, enum: ['IN_PROGRESS', 'COMPLETED'], required: true, default: 'IN_PROGRESS' },
    responseStatus: { type: Number, default: null },
    responseBody: { type: Schema.Types.Mixed, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'idempotency_keys', strict: 'throw', minimize: false },
);

// Scoped to the user: two people may legitimately generate the same UUID, and one must not
// receive the other's order.
idempotencyKeySchema.index({ key: 1, userId: 1 }, { unique: true });
idempotencyKeySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const IdempotencyKeyModel: Model<IdempotencyKeyDoc> = model<IdempotencyKeyDoc>(
  'IdempotencyKey',
  idempotencyKeySchema,
);
