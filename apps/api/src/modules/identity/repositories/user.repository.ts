import { Types, type ClientSession } from 'mongoose';
import { UserStatus, type Locale, type UserRole } from '@bozorlar/types';
import { UserModel, type UserDoc } from '../models/user.model.js';
import { UserProfileModel, type UserProfileDoc } from '../models/userProfile.model.js';

/**
 * The repository is the only layer that touches Mongoose models (ADR-0011 rule 2). Services
 * receive plain objects, which is also what makes the ledger portable if ADR-0001's escape
 * hatch is ever taken.
 */
export interface UserRecord {
  id: string;
  phone: string;
  phoneVerifiedAt: Date | null;
  roles: UserRole[];
  status: UserStatus;
  locale: Locale;
  twoFactorEnabled: boolean;
  failedLoginCount: number;
  lockedUntil: Date | null;
  passwordChangedAt: Date;
  shopIds: string[];
  createdAt: Date;
}

export interface UserWithSecrets extends UserRecord {
  passwordHash: string;
  twoFactorSecret: string | null;
}

export interface ProfileRecord {
  firstName: string;
  lastName: string | null;
  avatarKey: string | null;
  defaultRegionId: string | null;
  defaultDistrictId: string | null;
}

function toRecord(doc: UserDoc): UserRecord {
  return {
    id: doc._id.toString(),
    phone: doc.phone,
    phoneVerifiedAt: doc.phoneVerifiedAt,
    roles: doc.roles,
    status: doc.status,
    locale: doc.locale,
    twoFactorEnabled: doc.twoFactorEnabled,
    failedLoginCount: doc.failedLoginCount,
    lockedUntil: doc.lockedUntil,
    passwordChangedAt: doc.passwordChangedAt,
    shopIds: doc.shopIds.map((id) => id.toString()),
    createdAt: doc.createdAt,
  };
}

function toProfileRecord(doc: UserProfileDoc): ProfileRecord {
  return {
    firstName: doc.firstName,
    lastName: doc.lastName,
    avatarKey: doc.avatarKey,
    defaultRegionId: doc.defaultRegionId?.toString() ?? null,
    defaultDistrictId: doc.defaultDistrictId?.toString() ?? null,
  };
}

export const userRepository = {
  async findById(id: string): Promise<UserRecord | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const doc = await UserModel.findOne({ _id: id, deletedAt: null }).lean<UserDoc>();
    return doc ? toRecord(doc) : null;
  },

  async findByPhone(phone: string): Promise<UserRecord | null> {
    const doc = await UserModel.findOne({ phone, deletedAt: null }).lean<UserDoc>();
    return doc ? toRecord(doc) : null;
  },

  /** Explicitly opts into the `select: false` fields. Used only by the auth service. */
  async findByPhoneWithSecrets(phone: string): Promise<UserWithSecrets | null> {
    const doc = await UserModel.findOne({ phone, deletedAt: null })
      .select('+passwordHash +twoFactorSecret')
      .lean<UserDoc>();
    if (!doc) return null;
    return { ...toRecord(doc), passwordHash: doc.passwordHash, twoFactorSecret: doc.twoFactorSecret };
  },

  async findByIdWithSecrets(id: string): Promise<UserWithSecrets | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const doc = await UserModel.findOne({ _id: id, deletedAt: null })
      .select('+passwordHash +twoFactorSecret')
      .lean<UserDoc>();
    if (!doc) return null;
    return { ...toRecord(doc), passwordHash: doc.passwordHash, twoFactorSecret: doc.twoFactorSecret };
  },

  async phoneExists(phone: string): Promise<boolean> {
    return (await UserModel.countDocuments({ phone }).limit(1)) > 0;
  },

  async create(
    input: {
      phone: string;
      passwordHash: string;
      locale: Locale;
      roles: UserRole[];
      profile: { firstName: string; lastName?: string | undefined };
    },
    session?: ClientSession,
  ): Promise<UserRecord> {
    const [user] = await UserModel.create(
      [
        {
          phone: input.phone,
          passwordHash: input.passwordHash,
          passwordChangedAt: new Date(),
          locale: input.locale,
          roles: input.roles,
          status: UserStatus.ACTIVE,
        },
      ],
      session ? { session } : {},
    );
    if (!user) throw new Error('User creation returned no document');

    await UserProfileModel.create(
      [
        {
          userId: user._id,
          firstName: input.profile.firstName,
          lastName: input.profile.lastName ?? null,
        },
      ],
      session ? { session } : {},
    );

    return toRecord(user.toObject<UserDoc>());
  },

  async getProfile(userId: string): Promise<ProfileRecord | null> {
    const doc = await UserProfileModel.findOne({ userId }).lean<UserProfileDoc>();
    return doc ? toProfileRecord(doc) : null;
  },

  async updateProfile(
    userId: string,
    patch: Partial<{
      firstName: string;
      lastName: string;
      defaultRegionId: string;
      defaultDistrictId: string;
    }>,
  ): Promise<ProfileRecord | null> {
    const doc = await UserProfileModel.findOneAndUpdate(
      { userId },
      { $set: patch },
      { new: true },
    ).lean<UserProfileDoc>();
    return doc ? toProfileRecord(doc) : null;
  },

  async updateLocale(userId: string, locale: Locale): Promise<void> {
    await UserModel.updateOne({ _id: userId }, { $set: { locale } });
  },

  async markPhoneVerified(userId: string): Promise<void> {
    await UserModel.updateOne({ _id: userId }, { $set: { phoneVerifiedAt: new Date() } });
  },

  async setPassword(userId: string, passwordHash: string): Promise<void> {
    await UserModel.updateOne(
      { _id: userId },
      { $set: { passwordHash, passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null } },
    );
  },

  async changePhone(userId: string, phone: string): Promise<void> {
    await UserModel.updateOne(
      { _id: userId },
      { $set: { phone, phoneVerifiedAt: new Date() } },
    );
  },

  /** Returns the new count so the caller can decide whether to lock. */
  async registerFailedLogin(userId: string, lockUntil: Date | null): Promise<number> {
    const doc = await UserModel.findOneAndUpdate(
      { _id: userId },
      { $inc: { failedLoginCount: 1 }, ...(lockUntil ? { $set: { lockedUntil: lockUntil } } : {}) },
      { new: true, projection: { failedLoginCount: 1 } },
    ).lean<Pick<UserDoc, 'failedLoginCount'>>();
    return doc?.failedLoginCount ?? 0;
  },

  async registerSuccessfulLogin(userId: string): Promise<void> {
    await UserModel.updateOne(
      { _id: userId },
      { $set: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } },
    );
  },

  async setTwoFactorSecret(userId: string, secret: string | null, enabled: boolean): Promise<void> {
    await UserModel.updateOne(
      { _id: userId },
      { $set: { twoFactorSecret: secret, twoFactorEnabled: enabled } },
    );
  },

  async scheduleDeletion(userId: string, reason: string | null): Promise<void> {
    await UserModel.updateOne(
      { _id: userId },
      {
        $set: {
          status: UserStatus.PENDING_DELETION,
          statusReason: reason ?? 'User requested account deletion',
        },
      },
    );
  },

  /**
   * Throttled to one write per five minutes. Writing on every request would multiply the
   * write load of the busiest collection for no operational benefit (DATABASE.md 5.3).
   */
  async touchLastSeen(userId: string): Promise<void> {
    const threshold = new Date(Date.now() - 5 * 60_000);
    await UserModel.updateOne(
      { _id: userId, $or: [{ lastSeenAt: null }, { lastSeenAt: { $lt: threshold } }] },
      { $set: { lastSeenAt: new Date() } },
    );
  },

  /**
   * Grants a role and registers shop ownership in one update.
   *
   * `shopIds` is denormalized from `shops.ownerId` and must move inside the same transaction
   * as shop creation, or an approved seller can end up with a shop they are not authorized
   * to manage (DATABASE.md 3.3).
   */
  async grantSellerRole(
    userId: string,
    shopId: string,
    role: UserRole,
    session?: ClientSession,
  ): Promise<void> {
    await UserModel.updateOne(
      { _id: userId },
      { $addToSet: { roles: role, shopIds: new Types.ObjectId(shopId) } },
      session ? { session } : {},
    );
  },

  async addShopMembership(
    userId: string,
    shopId: string,
    role: UserRole,
    session?: ClientSession,
  ): Promise<void> {
    await UserModel.updateOne(
      { _id: userId },
      { $addToSet: { roles: role, shopIds: new Types.ObjectId(shopId) } },
      session ? { session } : {},
    );
  },

  /**
   * Removes shop access. The role is only revoked when the user has no remaining shops,
   * because a staff member removed from one stall may still work at another.
   */
  async removeShopMembership(
    userId: string,
    shopId: string,
    role: UserRole,
    session?: ClientSession,
  ): Promise<void> {
    const options = session ? { session } : {};
    await UserModel.updateOne(
      { _id: userId },
      { $pull: { shopIds: new Types.ObjectId(shopId) } },
      options,
    );
    const doc = await UserModel.findById(userId)
      .select({ shopIds: 1 })
      .session(session ?? null)
      .lean<Pick<UserDoc, 'shopIds'>>();
    if (doc && doc.shopIds.length === 0) {
      await UserModel.updateOne({ _id: userId }, { $pull: { roles: role } }, options);
    }
  },
};
