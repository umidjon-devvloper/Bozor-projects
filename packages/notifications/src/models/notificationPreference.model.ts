import { Schema, model, type Model, type Types } from 'mongoose';
import { Channel, NotificationCategory } from '../constants.js';

/**
 * Per-user channel preferences.
 *
 * Absence means "the defaults", so a user who has never opened the settings screen still gets
 * exactly what they should. Only marketing can actually be switched off; the model stores a
 * preference for every category anyway, because the delivery engine — not the storage — is
 * where that rule belongs, and hiding it in a schema constraint would make it invisible.
 */
export interface NotificationPreferenceDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  channels: Array<{ category: NotificationCategory; channel: Channel; enabled: boolean }>;
  timezone: string;
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const preferenceSchema = new Schema<NotificationPreferenceDoc>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    channels: {
      type: [
        new Schema(
          {
            category: { type: String, enum: Object.values(NotificationCategory), required: true },
            channel: { type: String, enum: Object.values(Channel), required: true },
            enabled: { type: Boolean, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
      validate: { validator: (v: unknown[]) => v.length <= 30, message: 'Too many preferences' },
    },
    timezone: { type: String, required: true, default: 'Asia/Tashkent', maxlength: 64 },
    schemaVersion: { type: Number, required: true, default: 1 },
  },
  { timestamps: true, collection: 'notification_preferences', strict: 'throw' },
);

preferenceSchema.index({ userId: 1 }, { unique: true });

export const NotificationPreferenceModel: Model<NotificationPreferenceDoc> =
  model<NotificationPreferenceDoc>('NotificationPreference', preferenceSchema);
