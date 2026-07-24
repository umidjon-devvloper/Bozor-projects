import { Types } from 'mongoose';
import type { Locale, Platform } from '@bozorlar/types';
import { DeviceModel, type DeviceDoc } from '../models/device.model.js';

export interface DeviceRecord {
  id: string;
  deviceId: string;
  platform: Platform;
  pushEnabled: boolean;
  appVersion: string | null;
  lastActiveAt: Date;
}

function toRecord(doc: DeviceDoc): DeviceRecord {
  return {
    id: doc._id.toString(),
    deviceId: doc.deviceId,
    platform: doc.platform,
    pushEnabled: doc.pushEnabled,
    appVersion: doc.appVersion,
    lastActiveAt: doc.lastActiveAt,
  };
}

export const deviceRepository = {
  async upsert(input: {
    userId: string;
    deviceId: string;
    platform: Platform;
    pushToken?: string | undefined;
    appVersion?: string | undefined;
    osVersion?: string | undefined;
    locale?: Locale | undefined;
  }): Promise<DeviceRecord> {
    const doc = await DeviceModel.findOneAndUpdate(
      { userId: new Types.ObjectId(input.userId), deviceId: input.deviceId },
      {
        $set: {
          platform: input.platform,
          ...(input.pushToken !== undefined
            ? { pushToken: input.pushToken, pushTokenUpdatedAt: new Date(), invalidatedAt: null }
            : {}),
          ...(input.appVersion !== undefined ? { appVersion: input.appVersion } : {}),
          ...(input.osVersion !== undefined ? { osVersion: input.osVersion } : {}),
          ...(input.locale !== undefined ? { locale: input.locale } : {}),
          lastActiveAt: new Date(),
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean<DeviceDoc>();
    return toRecord(doc);
  },

  async update(
    userId: string,
    deviceId: string,
    patch: { pushToken?: string; pushEnabled?: boolean; locale?: Locale },
  ): Promise<DeviceRecord | null> {
    const doc = await DeviceModel.findOneAndUpdate(
      { userId, deviceId },
      {
        $set: {
          ...patch,
          ...(patch.pushToken !== undefined
            ? { pushTokenUpdatedAt: new Date(), invalidatedAt: null }
            : {}),
        },
      },
      { new: true },
    ).lean<DeviceDoc>();
    return doc ? toRecord(doc) : null;
  },

  async remove(userId: string, deviceId: string): Promise<boolean> {
    const result = await DeviceModel.deleteOne({ userId, deviceId });
    return result.deletedCount === 1;
  },

  async listForUser(userId: string): Promise<DeviceRecord[]> {
    const docs = await DeviceModel.find({ userId }).sort({ lastActiveAt: -1 }).lean<DeviceDoc[]>();
    return docs.map(toRecord);
  },
};
