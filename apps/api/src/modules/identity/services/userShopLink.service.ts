import { Types, type ClientSession } from 'mongoose';
import { UserModel } from '../models/user.model.js';
import { UserRole } from '@bozorlar/types';

/**
 * Keeps `users.shopIds` in step with shop ownership and membership.
 *
 * This denormalization exists so that authorization does not need a join on every seller
 * request (DATABASE.md 3.3). Because it participates in a *permission* decision, it is
 * updated inside the same transaction as the shop write — eventual consistency here would
 * mean a window in which a legitimate owner is denied access to their own shop.
 *
 * Exposed through the identity module's public surface so the geo module never reaches into
 * another module's repository (ADR-0011 rule 1).
 */
export const userShopLinkService = {
  async attachShop(
    userId: string,
    shopId: string,
    options: { grantSellerRole: boolean },
    session: ClientSession,
  ): Promise<void> {
    await UserModel.updateOne(
      { _id: userId },
      {
        $addToSet: {
          shopIds: new Types.ObjectId(shopId),
          ...(options.grantSellerRole
            ? { roles: UserRole.SELLER_OWNER }
            : { roles: UserRole.SELLER_STAFF }),
        },
      },
      { session },
    );
  },

  /**
   * Grants the seller role on its own, with no shop attached.
   *
   * Seller onboarding approves the *person* before any stall exists: the applicant is told
   * they may trade, and then opens their shop. Without this, approval would have to invent a
   * shop in order to grant the role (ADR-0031).
   */
  async grantSellerRole(userId: string, session: ClientSession): Promise<void> {
    await UserModel.updateOne(
      { _id: userId },
      { $addToSet: { roles: UserRole.SELLER_OWNER } },
      { session },
    );
  },

  async detachShop(userId: string, shopId: string, session: ClientSession): Promise<void> {
    await UserModel.updateOne(
      { _id: userId },
      { $pull: { shopIds: new Types.ObjectId(shopId) } },
      { session },
    );

    // Staff who no longer belong to any shop lose the staff role, since it grants permission
    // keys that map to no resource. SELLER_OWNER is deliberately left alone: it is granted by
    // onboarding approval and represents the right to trade, which outlives any one shop
    // (ADR-0031). Revoking it here would silently un-approve a seller who closed a stall.
    const remaining = await UserModel.findOne({ _id: userId }, { shopIds: 1 })
      .session(session)
      .lean<{ shopIds: Types.ObjectId[] }>();
    if (remaining && remaining.shopIds.length === 0) {
      await UserModel.updateOne(
        { _id: userId },
        { $pull: { roles: UserRole.SELLER_STAFF } },
        { session },
      );
    }
  },

  async userExistsAndActive(userId: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(userId)) return false;
    return (
      (await UserModel.countDocuments({ _id: userId, status: 'ACTIVE', deletedAt: null }).limit(1)) > 0
    );
  },

  async findActiveIdByPhone(phone: string): Promise<string | null> {
    const doc = await UserModel.findOne({ phone, status: 'ACTIVE', deletedAt: null }, { _id: 1 })
      .lean<{ _id: Types.ObjectId }>();
    return doc ? doc._id.toString() : null;
  },
};
