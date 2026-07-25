import { Types } from 'mongoose';
import { NotificationModel, type DeliveryAttempt, type NotificationDoc } from '../models/notification.model.js';
import {
  NotificationPreferenceModel,
  type NotificationPreferenceDoc,
} from '../models/notificationPreference.model.js';
import type { Channel, NotificationCategory } from '../constants.js';

export interface NotificationRecord {
  id: string;
  dedupeKey: string;
  userId: string;
  category: NotificationCategory;
  type: string;
  title: string;
  body: string;
  target: { type: string; id: string } | null;
  data: Record<string, string>;
  attempts: DeliveryAttempt[];
  readAt: Date | null;
  createdAt: Date;
}

function toRecord(doc: NotificationDoc): NotificationRecord {
  return {
    id: doc._id.toString(),
    dedupeKey: doc.dedupeKey,
    userId: doc.userId.toString(),
    category: doc.category,
    type: doc.type,
    title: doc.title,
    body: doc.body,
    target: doc.target,
    data:
      doc.data instanceof Map
        ? Object.fromEntries<string>(doc.data)
        : ((doc.data ?? {})),
    attempts: doc.attempts,
    readAt: doc.readAt,
    createdAt: doc.createdAt,
  };
}

export const notificationRepository = {
  /**
   * Claims the right to notify.
   *
   * The unique `dedupeKey` is the whole idempotency story: an event redelivered by the outbox
   * relay loses this insert and sends nothing. Returning null rather than throwing keeps that
   * an expected outcome at the call site instead of an exception to catch and ignore.
   */
  async claim(input: {
    dedupeKey: string;
    userId: string;
    category: NotificationCategory;
    type: string;
    title: string;
    body: string;
    locale: string;
    target: { type: string; id: string } | null;
    data: Record<string, string>;
  }): Promise<NotificationRecord | null> {
    try {
      const doc = await NotificationModel.create({
        ...input,
        userId: new Types.ObjectId(input.userId),
      });
      return toRecord(doc.toObject<NotificationDoc>());
    } catch (error) {
      if ((error as { code?: number }).code === 11000) return null;
      throw error;
    }
  },

  async recordAttempts(notificationId: string, attempts: DeliveryAttempt[]): Promise<void> {
    if (attempts.length === 0) return;
    await NotificationModel.updateOne(
      { _id: notificationId },
      { $push: { attempts: { $each: attempts } } },
    );
  },

  async listForUser(
    userId: string,
    limit: number,
    before?: Date,
  ): Promise<NotificationRecord[]> {
    const filter: Record<string, unknown> = { userId: new Types.ObjectId(userId) };
    if (before) filter.createdAt = { $lt: before };
    const docs = await NotificationModel.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean<NotificationDoc[]>();
    return docs.map(toRecord);
  },

  async unreadCount(userId: string): Promise<number> {
    return NotificationModel.countDocuments({ userId, readAt: null });
  },

  async markRead(userId: string, notificationId: string): Promise<boolean> {
    const result = await NotificationModel.updateOne(
      { _id: notificationId, userId, readAt: null },
      { $set: { readAt: new Date() } },
    );
    return result.modifiedCount === 1;
  },

  async markAllRead(userId: string): Promise<number> {
    const result = await NotificationModel.updateMany(
      { userId, readAt: null },
      { $set: { readAt: new Date() } },
    );
    return result.modifiedCount;
  },
};

export interface PreferenceRecord {
  userId: string;
  timezone: string;
  channels: Array<{ category: NotificationCategory; channel: Channel; enabled: boolean }>;
}

export const preferenceRepository = {
  async findForUser(userId: string): Promise<PreferenceRecord | null> {
    if (!Types.ObjectId.isValid(userId)) return null;
    const doc = await NotificationPreferenceModel.findOne({ userId }).lean<NotificationPreferenceDoc>();
    return doc
      ? { userId: doc.userId.toString(), timezone: doc.timezone, channels: doc.channels }
      : null;
  },

  async upsert(
    userId: string,
    input: {
      channels: Array<{ category: NotificationCategory; channel: Channel; enabled: boolean }>;
      timezone?: string;
    },
  ): Promise<PreferenceRecord> {
    const doc = await NotificationPreferenceModel.findOneAndUpdate(
      { userId: new Types.ObjectId(userId) },
      {
        $set: {
          channels: input.channels,
          ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        },
        $setOnInsert: { userId: new Types.ObjectId(userId), schemaVersion: 1 },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true },
    ).lean<NotificationPreferenceDoc>();
    return { userId: doc.userId.toString(), timezone: doc.timezone, channels: doc.channels };
  },
};
