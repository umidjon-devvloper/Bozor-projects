import mongoose, { Types } from 'mongoose';

/**
 * Reads recipients straight from the collections the identity module owns.
 *
 * Deliberately a raw read rather than an import: the notification engine runs in the worker,
 * which may not import the API app (ADR-0011), and the shape it needs — a phone number, a
 * locale, and a list of live push tokens — is small and stable enough not to justify a
 * package boundary of its own.
 */
export interface RecipientDevice {
  deviceId: string;
  platform: 'IOS' | 'ANDROID' | 'WEB';
  pushToken: string;
}

export interface Recipient {
  userId: string;
  phone: string;
  locale: string;
  status: string;
  devices: RecipientDevice[];
}

export const recipientRepository = {
  async find(userId: string): Promise<Recipient | null> {
    const db = mongoose.connection.db;
    if (!db || !Types.ObjectId.isValid(userId)) return null;

    const user = await db
      .collection<{ _id: Types.ObjectId; phone: string; locale: string; status: string }>('users')
      .findOne({ _id: new Types.ObjectId(userId) }, { projection: { phone: 1, locale: 1, status: 1 } });
    if (!user) return null;

    // Invalidated tokens are excluded here rather than filtered later, so a retired device
    // never enters a send batch and cannot be retired twice.
    const devices = await db
      .collection<{ deviceId: string; platform: string; pushToken: string | null }>('devices')
      .find({
        userId: new Types.ObjectId(userId),
        pushEnabled: true,
        invalidatedAt: null,
        pushToken: { $ne: null },
      })
      .toArray();

    return {
      userId,
      phone: user.phone,
      locale: user.locale,
      status: user.status,
      devices: devices
        .filter((device): device is typeof device & { pushToken: string } => device.pushToken !== null)
        .map((device) => ({
          deviceId: device.deviceId,
          platform: device.platform as RecipientDevice['platform'],
          pushToken: device.pushToken,
        })),
    };
  },

  /**
   * Retires a token the provider has told us is dead.
   *
   * `devices.invalidatedAt` has had a partial index excluding it from fan-out since the
   * identity module was built, and nothing has written to it until now. Retiring rather than
   * deleting keeps the device row for the user's session list.
   */
  async invalidateToken(pushToken: string, reason: string): Promise<number> {
    const db = mongoose.connection.db;
    if (!db) return 0;
    const result = await db
      .collection('devices')
      .updateMany(
        { pushToken, invalidatedAt: null },
        { $set: { invalidatedAt: new Date(), invalidationReason: reason } },
      );
    return result.modifiedCount;
  },
};
