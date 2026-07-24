import { Schema, model, type Model, type Types } from 'mongoose';
import { LOCALES, Platform, type Locale } from '@bozorlar/types';

export interface DeviceDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  deviceId: string;
  platform: Platform;
  pushToken: string | null;
  pushTokenUpdatedAt: Date | null;
  pushEnabled: boolean;
  appVersion: string | null;
  osVersion: string | null;
  locale: Locale | null;
  lastActiveAt: Date;
  /** Set from provider NotRegistered responses; excluded from fan-out by a partial index. */
  invalidatedAt: Date | null;
  /** The provider's own verdict, kept so a retirement can be explained later. */
  invalidationReason: string | null;
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const deviceSchema = new Schema<DeviceDoc>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    deviceId: { type: String, required: true, trim: true },
    platform: { type: String, enum: Object.values(Platform), required: true },
    pushToken: { type: String, default: null, maxlength: 512 },
    pushTokenUpdatedAt: { type: Date, default: null },
    pushEnabled: { type: Boolean, required: true, default: true },
    appVersion: { type: String, default: null, maxlength: 32 },
    osVersion: { type: String, default: null, maxlength: 32 },
    locale: { type: String, enum: LOCALES, default: null },
    lastActiveAt: { type: Date, required: true, default: () => new Date() },
    invalidatedAt: { type: Date, default: null },
    invalidationReason: { type: String, default: null, maxlength: 64 },
    schemaVersion: { type: Number, required: true, default: 1 },
  },
  { timestamps: true, collection: 'devices', strict: 'throw' },
);

deviceSchema.index({ userId: 1, deviceId: 1 }, { unique: true });
deviceSchema.index({ pushToken: 1 }, { sparse: true, partialFilterExpression: { invalidatedAt: null } });
deviceSchema.index({ userId: 1, pushEnabled: 1, invalidatedAt: 1 });
deviceSchema.index({ lastActiveAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 180 });

export const DeviceModel: Model<DeviceDoc> = model<DeviceDoc>('Device', deviceSchema);
