import { Schema, model, type Model, type Types } from 'mongoose';
import { Channel, DeliveryStatus, NotificationCategory, SuppressionReason } from '../constants.js';

/**
 * A notification that was, or deliberately was not, delivered.
 *
 * One document per recipient per event, holding every channel attempt. Kept even when nothing
 * was sent: "we suppressed this because they opted out" is the answer to a support question
 * that otherwise has none.
 */
export interface DeliveryAttempt {
  channel: Channel;
  status: DeliveryStatus;
  provider: string | null;
  providerMessageId: string | null;
  error: string | null;
  suppressionReason: SuppressionReason | null;
  attemptedAt: Date;
}

export interface NotificationDoc {
  _id: Types.ObjectId;
  /** Natural key. Derived from the event, so a redelivery cannot notify twice. */
  dedupeKey: string;
  userId: Types.ObjectId;
  category: NotificationCategory;
  type: string;
  title: string;
  body: string;
  locale: string;
  /** Deep-link target, e.g. `{ type: 'order', id: '...' }`. */
  target: { type: string; id: string } | null;
  data: Record<string, string>;
  attempts: DeliveryAttempt[];
  readAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  schemaVersion: number;
}

const attemptSchema = new Schema<DeliveryAttempt>(
  {
    channel: { type: String, enum: Object.values(Channel), required: true },
    status: { type: String, enum: Object.values(DeliveryStatus), required: true },
    provider: { type: String, default: null, maxlength: 32 },
    providerMessageId: { type: String, default: null, maxlength: 256 },
    error: { type: String, default: null, maxlength: 500 },
    suppressionReason: { type: String, enum: Object.values(SuppressionReason), default: null },
    attemptedAt: { type: Date, required: true, default: () => new Date() },
  },
  { _id: false },
);

const notificationSchema = new Schema<NotificationDoc>(
  {
    dedupeKey: { type: String, required: true, maxlength: 160 },
    userId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    category: { type: String, enum: Object.values(NotificationCategory), required: true },
    type: { type: String, required: true, maxlength: 64 },
    title: { type: String, required: true, maxlength: 120 },
    body: { type: String, required: true, maxlength: 400 },
    locale: { type: String, required: true, maxlength: 16 },
    target: {
      type: new Schema(
        { type: { type: String, required: true, maxlength: 32 }, id: { type: String, required: true } },
        { _id: false },
      ),
      default: null,
    },
    data: { type: Map, of: String, default: {} },
    attempts: { type: [attemptSchema], default: [] },
    readAt: { type: Date, default: null },
    schemaVersion: { type: Number, required: true, default: 1 },
  },
  { timestamps: true, collection: 'notifications', strict: 'throw', minimize: false },
);

// The idempotency guard: one notification per recipient per event.
notificationSchema.index({ dedupeKey: 1 }, { unique: true });
notificationSchema.index({ userId: 1, createdAt: -1 });
// The unread badge, kept small by a partial index.
notificationSchema.index({ userId: 1, readAt: 1 }, { partialFilterExpression: { readAt: null } });
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

export const NotificationModel: Model<NotificationDoc> = model<NotificationDoc>(
  'Notification',
  notificationSchema,
);
