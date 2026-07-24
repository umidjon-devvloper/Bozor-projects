import { Schema, model, type Model, type Types } from 'mongoose';

/**
 * Transactional outbox (ADR-0012). Events are written inside the same transaction as the
 * state change, then relayed after commit. This is what removes the dual-write problem:
 * an event can never exist without its state change, or vice versa.
 */
export interface OutboxDoc {
  _id: Types.ObjectId;
  eventId: string;
  type: string;
  version: number;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  traceId: string | null;
  actorId: Types.ObjectId | null;
  actorType: string;
  occurredAt: Date;
  publishedAt: Date | null;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const outboxSchema = new Schema<OutboxDoc>(
  {
    eventId: { type: String, required: true },
    type: { type: String, required: true, maxlength: 100 },
    version: { type: Number, required: true, default: 1 },
    aggregateType: { type: String, required: true, maxlength: 50 },
    aggregateId: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    traceId: { type: String, default: null },
    actorId: { type: Schema.Types.ObjectId, default: null },
    actorType: { type: String, required: true, default: 'SYSTEM' },
    occurredAt: { type: Date, required: true, default: () => new Date() },
    publishedAt: { type: Date, default: null },
    attempts: { type: Number, required: true, default: 0 },
    lastError: { type: String, default: null, maxlength: 1000 },
  },
  { timestamps: true, collection: 'outbox', strict: 'throw' },
);

outboxSchema.index({ eventId: 1 }, { unique: true });
// The relay cursor. A partial index on unpublished rows keeps the scan O(backlog) rather
// than O(total events) — the difference between a cheap poll and a rolling scan.
outboxSchema.index({ occurredAt: 1 }, { partialFilterExpression: { publishedAt: null } });
outboxSchema.index({ aggregateType: 1, aggregateId: 1, occurredAt: 1 });
outboxSchema.index({ publishedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 7 });

export const OutboxModel: Model<OutboxDoc> = model<OutboxDoc>('Outbox', outboxSchema);
