import { Types, type ClientSession } from 'mongoose';
import { FavouriteModel, type FavouriteDoc } from '../models/favourite.model.js';
import { ALERT_FANOUT_BATCH_SIZE, FavouriteTarget } from '../constants.js';
import type { FavouriteAlertState } from '../alertPolicy.js';

export interface FavouriteRecord {
  id: string;
  userId: string;
  targetType: FavouriteTarget;
  targetId: string;
  shopId: string | null;
  alertsEnabled: boolean;
  state: FavouriteAlertState;
  createdAt: Date;
}

function toRecord(doc: FavouriteDoc): FavouriteRecord {
  return {
    id: doc._id.toString(),
    userId: doc.userId.toString(),
    targetType: doc.targetType,
    targetId: doc.targetId.toString(),
    shopId: doc.shopId ? doc.shopId.toString() : null,
    alertsEnabled: doc.alertsEnabled,
    state: {
      priceWatermarkMinor: doc.priceWatermarkMinor,
      wasPurchasable: doc.wasPurchasable,
      lastPriceAlertAt: doc.lastPriceAlertAt,
      lastRestockAlertAt: doc.lastRestockAlertAt,
    },
    createdAt: doc.createdAt,
  };
}

export const favouriteRepository = {
  /**
   * Adds a favourite, or returns the existing one unchanged.
   *
   * An upsert rather than an insert-and-catch, because tapping a heart twice is a normal
   * thing for a person to do on a slow connection and should not surface as a conflict. The
   * `$setOnInsert` is what makes it non-destructive: a second tap must never reset the
   * watermark, or a user could clear their own alert history by accident.
   */
  async add(input: {
    userId: string;
    targetType: FavouriteTarget;
    targetId: string;
    shopId: string | null;
    initialState: FavouriteAlertState;
  }, session?: ClientSession): Promise<{ record: FavouriteRecord; created: boolean }> {
    const filter = {
      userId: new Types.ObjectId(input.userId),
      targetType: input.targetType,
      targetId: new Types.ObjectId(input.targetId),
    };
    const before = await FavouriteModel.findOne(filter).session(session ?? null).lean<FavouriteDoc>();
    const doc = await FavouriteModel.findOneAndUpdate(
      filter,
      {
        $setOnInsert: {
          shopId: input.shopId ? new Types.ObjectId(input.shopId) : null,
          priceWatermarkMinor: input.initialState.priceWatermarkMinor,
          wasPurchasable: input.initialState.wasPurchasable,
          lastPriceAlertAt: null,
          lastRestockAlertAt: null,
          alertsEnabled: true,
          schemaVersion: 1,
        },
      },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: false, ...(session ? { session } : {}) },
    ).lean<FavouriteDoc>();
    if (!doc) throw new Error('Favourite upsert returned no document');
    return { record: toRecord(doc), created: before === null };
  },

  async remove(
    userId: string,
    targetType: FavouriteTarget,
    targetId: string,
    session?: ClientSession,
  ): Promise<boolean> {
    if (!Types.ObjectId.isValid(targetId)) return false;
    const result = await FavouriteModel.deleteOne(
      {
        userId: new Types.ObjectId(userId),
        targetType,
        targetId: new Types.ObjectId(targetId),
      },
      session ? { session } : {},
    );
    return result.deletedCount === 1;
  },

  async setAlertsEnabled(
    userId: string,
    targetId: string,
    enabled: boolean,
  ): Promise<FavouriteRecord | null> {
    if (!Types.ObjectId.isValid(targetId)) return null;
    const doc = await FavouriteModel.findOneAndUpdate(
      {
        userId: new Types.ObjectId(userId),
        targetType: FavouriteTarget.PRODUCT,
        targetId: new Types.ObjectId(targetId),
      },
      { $set: { alertsEnabled: enabled } },
      { new: true },
    ).lean<FavouriteDoc>();
    return doc ? toRecord(doc) : null;
  },

  async countForUser(userId: string): Promise<number> {
    return FavouriteModel.countDocuments({ userId: new Types.ObjectId(userId) });
  },

  /** Cursor pagination on `_id`, matching the convention used everywhere else. */
  async listForUser(input: {
    userId: string;
    targetType: FavouriteTarget;
    limit: number;
    beforeId: string | null;
  }): Promise<FavouriteRecord[]> {
    const filter: Record<string, unknown> = {
      userId: new Types.ObjectId(input.userId),
      targetType: input.targetType,
    };
    if (input.beforeId && Types.ObjectId.isValid(input.beforeId)) {
      filter._id = { $lt: new Types.ObjectId(input.beforeId) };
    }
    const docs = await FavouriteModel.find(filter)
      .sort({ _id: -1 })
      .limit(input.limit + 1)
      .lean<FavouriteDoc[]>();
    return docs.map(toRecord);
  },

  /**
   * Which of these targets the user already follows.
   *
   * Exists because a catalogue page renders forty products and needs forty hearts in the
   * right state. Forty round trips for that would be indefensible; one `$in` is not.
   */
  async filterFollowed(
    userId: string,
    targetType: FavouriteTarget,
    targetIds: readonly string[],
  ): Promise<string[]> {
    const ids = targetIds.filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
    if (ids.length === 0) return [];
    const docs = await FavouriteModel.find({
      userId: new Types.ObjectId(userId),
      targetType,
      targetId: { $in: ids },
    })
      .select({ targetId: 1 })
      .lean<{ targetId: Types.ObjectId }[]>();
    return docs.map((doc) => doc.targetId.toString());
  },

  async countFollowers(targetType: FavouriteTarget, targetId: string): Promise<number> {
    if (!Types.ObjectId.isValid(targetId)) return 0;
    return FavouriteModel.countDocuments({
      targetType,
      targetId: new Types.ObjectId(targetId),
    });
  },

  /** One page of the people following a product, for the alert fan-out. */
  async pageFollowers(input: {
    targetId: string;
    afterId: string | null;
  }): Promise<FavouriteRecord[]> {
    if (!Types.ObjectId.isValid(input.targetId)) return [];
    const filter: Record<string, unknown> = {
      targetType: FavouriteTarget.PRODUCT,
      targetId: new Types.ObjectId(input.targetId),
      alertsEnabled: true,
    };
    if (input.afterId) filter._id = { $gt: new Types.ObjectId(input.afterId) };
    const docs = await FavouriteModel.find(filter)
      .sort({ _id: 1 })
      .limit(ALERT_FANOUT_BATCH_SIZE)
      .lean<FavouriteDoc[]>();
    return docs.map(toRecord);
  },

  async productIdsFollowedInShop(shopId: string): Promise<string[]> {
    if (!Types.ObjectId.isValid(shopId)) return [];
    const ids = await FavouriteModel.distinct('targetId', {
      targetType: FavouriteTarget.PRODUCT,
      shopId: new Types.ObjectId(shopId),
    });
    return (ids).map((id) => id.toString());
  },

  /**
   * Moves a favourite's alert state forward, but only from the state the decision was taken
   * against.
   *
   * This conditional update is the idempotency guard for the whole alerting path, and it is
   * deliberately the *same* mechanism the stock reservation uses (ADR-0032): MongoDB is the
   * authority, and a compare-and-set is what makes at-least-once delivery safe. A redelivered
   * event recomputes the same decision, tries to advance from a watermark that has already
   * moved, matches nothing, and sends nothing. No lock, no dedupe table, no window in which
   * two workers could both decide to notify.
   */
  async advanceState(
    favouriteId: string,
    expected: FavouriteAlertState,
    next: FavouriteAlertState,
  ): Promise<boolean> {
    const result = await FavouriteModel.updateOne(
      {
        _id: new Types.ObjectId(favouriteId),
        priceWatermarkMinor: expected.priceWatermarkMinor,
        wasPurchasable: expected.wasPurchasable,
        lastPriceAlertAt: expected.lastPriceAlertAt,
        lastRestockAlertAt: expected.lastRestockAlertAt,
      },
      {
        $set: {
          priceWatermarkMinor: next.priceWatermarkMinor,
          wasPurchasable: next.wasPurchasable,
          lastPriceAlertAt: next.lastPriceAlertAt,
          lastRestockAlertAt: next.lastRestockAlertAt,
        },
      },
    );
    return result.modifiedCount === 1;
  },

  /** Removing a product removes the interest in it; a dangling favourite is a dead link. */
  async removeAllForTarget(targetType: FavouriteTarget, targetId: string): Promise<number> {
    if (!Types.ObjectId.isValid(targetId)) return 0;
    const result = await FavouriteModel.deleteMany({
      targetType,
      targetId: new Types.ObjectId(targetId),
    });
    return result.deletedCount;
  },
};
