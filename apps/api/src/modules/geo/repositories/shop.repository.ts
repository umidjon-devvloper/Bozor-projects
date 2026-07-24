import { Types, type ClientSession } from 'mongoose';
import type {
  LocalizedText,
  ModerationStatus,
  ShopMemberRole,
  ShopStatus,
  WorkingHoursEntry,
} from '@bozorlar/types';
import { ShopModel, type ShopDoc } from '../models/shop.model.js';
import type { MediaRef } from '../models/market.model.js';
import type { ParsedQuery } from '../../../http/query.js';

export interface ShopMemberRecord {
  userId: string;
  role: ShopMemberRole;
  addedAt: Date;
}

export interface ShopRecord {
  id: string;
  ownerId: string;
  marketId: string;
  districtId: string;
  regionId: string;
  name: LocalizedText;
  slug: string;
  description: LocalizedText | null;
  logo: MediaRef | null;
  cover: MediaRef | null;
  photos: MediaRef[];
  sectionCode: string | null;
  stallNo: string | null;
  contactPhone: string;
  members: ShopMemberRecord[];
  categoryIds: string[];
  workingHours: WorkingHoursEntry[];
  timezone: string;
  vacationUntil: Date | null;
  status: ShopStatus;
  moderationStatus: ModerationStatus;
  moderationReason: string | null;
  sellerWalletActive: boolean;
  isVisible: boolean;
  visibilityReason: string;
  ratingAvg: number;
  ratingCount: number;
  ratingBayesian: number;
  productCount: number;
  salesCount: number;
  reliabilityScore: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateShopInput {
  ownerId: string;
  marketId: string;
  districtId: string;
  regionId: string;
  name: LocalizedText;
  slug: string;
  description: LocalizedText | null;
  sectionCode: string | null;
  stallNo: string | null;
  contactPhone: string;
  categoryIds: string[];
  workingHours: WorkingHoursEntry[];
  timezone: string;
  location: { lat: number; lng: number } | null;
}

function toRecord(doc: ShopDoc): ShopRecord {
  return {
    id: doc._id.toString(),
    ownerId: doc.ownerId.toString(),
    marketId: doc.marketId.toString(),
    districtId: doc.districtId.toString(),
    regionId: doc.regionId.toString(),
    name: doc.name,
    slug: doc.slug,
    description: doc.description,
    logo: doc.logo,
    cover: doc.cover,
    photos: doc.photos,
    sectionCode: doc.sectionCode,
    stallNo: doc.stallNo,
    contactPhone: doc.contactPhone,
    members: doc.members.map((member) => ({
      userId: member.userId.toString(),
      role: member.role,
      addedAt: member.addedAt,
    })),
    categoryIds: doc.categoryIds.map((id) => id.toString()),
    workingHours: doc.workingHours,
    timezone: doc.timezone,
    vacationUntil: doc.vacationUntil,
    status: doc.status,
    moderationStatus: doc.moderationStatus,
    moderationReason: doc.moderationReason,
    sellerWalletActive: doc.sellerWalletActive,
    isVisible: doc.isVisible,
    visibilityReason: doc.visibilityReason,
    ratingAvg: doc.ratingAvg,
    ratingCount: doc.ratingCount,
    ratingBayesian: doc.ratingBayesian,
    productCount: doc.productCount,
    salesCount: doc.salesCount,
    reliabilityScore: doc.reliabilityScore,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export const shopRepository = {
  async create(input: CreateShopInput, session: ClientSession): Promise<ShopRecord> {
    const ownerId = new Types.ObjectId(input.ownerId);
    const [doc] = await ShopModel.create(
      [
        {
          ownerId,
          marketId: new Types.ObjectId(input.marketId),
          districtId: new Types.ObjectId(input.districtId),
          regionId: new Types.ObjectId(input.regionId),
          name: input.name,
          slug: input.slug,
          description: input.description,
          sectionCode: input.sectionCode,
          stallNo: input.stallNo,
          contactPhone: input.contactPhone,
          categoryIds: input.categoryIds.map((id) => new Types.ObjectId(id)),
          workingHours: input.workingHours,
          timezone: input.timezone,
          location: input.location
            ? { type: 'Point' as const, coordinates: [input.location.lng, input.location.lat] }
            : null,
          members: [{ userId: ownerId, role: 'OWNER', addedAt: new Date(), addedBy: ownerId }],
        },
      ],
      { session },
    );
    if (!doc) throw new Error('Shop creation returned no document');
    return toRecord(doc.toObject<ShopDoc>());
  },

  async findById(id: string): Promise<ShopRecord | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const doc = await ShopModel.findOne({ _id: id, deletedAt: null }).lean<ShopDoc>();
    return doc ? toRecord(doc) : null;
  },

  async findByIdOrSlug(idOrSlug: string): Promise<ShopRecord | null> {
    const filter = Types.ObjectId.isValid(idOrSlug)
      ? { _id: idOrSlug, deletedAt: null }
      : { slug: idOrSlug.toLowerCase(), deletedAt: null };
    const doc = await ShopModel.findOne(filter).lean<ShopDoc>();
    return doc ? toRecord(doc) : null;
  },

  async list(parsed: ParsedQuery): Promise<ShopRecord[]> {
    const base = { ...parsed.filter, deletedAt: null };
    const filter = parsed.cursorFilter ? { $and: [base, parsed.cursorFilter] } : base;
    const docs = await ShopModel.find(filter)
      .sort(parsed.sort)
      .limit(parsed.limit + 1)
      .lean<ShopDoc[]>();
    return docs.map(toRecord);
  },

  async listForUser(userId: string): Promise<ShopRecord[]> {
    const docs = await ShopModel.find({ 'members.userId': userId, deletedAt: null })
      .sort({ createdAt: -1 })
      .lean<ShopDoc[]>();
    return docs.map(toRecord);
  },

  async slugExists(slug: string): Promise<boolean> {
    return (await ShopModel.countDocuments({ slug }).limit(1)) > 0;
  },

  async stallTaken(marketId: string, sectionCode: string, stallNo: string): Promise<boolean> {
    return (
      (await ShopModel.countDocuments({ marketId, sectionCode, stallNo, deletedAt: null }).limit(1)) > 0
    );
  },

  async update(
    id: string,
    patch: Record<string, unknown>,
    session?: ClientSession,
  ): Promise<ShopRecord | null> {
    const doc = await ShopModel.findOneAndUpdate(
      { _id: id, deletedAt: null },
      { $set: patch },
      { new: true, runValidators: true, ...(session ? { session } : {}) },
    ).lean<ShopDoc>();
    return doc ? toRecord(doc) : null;
  },

  async addMember(
    shopId: string,
    member: { userId: string; role: ShopMemberRole; addedBy: string },
    session: ClientSession,
  ): Promise<ShopRecord | null> {
    const doc = await ShopModel.findOneAndUpdate(
      // The $ne guard makes a duplicate add a no-op at the storage layer rather than relying
      // on the service to have read the document first.
      { _id: shopId, deletedAt: null, 'members.userId': { $ne: new Types.ObjectId(member.userId) } },
      {
        $push: {
          members: {
            userId: new Types.ObjectId(member.userId),
            role: member.role,
            addedAt: new Date(),
            addedBy: new Types.ObjectId(member.addedBy),
          },
        },
      },
      { new: true, session },
    ).lean<ShopDoc>();
    return doc ? toRecord(doc) : null;
  },

  async updateMemberRole(
    shopId: string,
    userId: string,
    role: ShopMemberRole,
  ): Promise<ShopRecord | null> {
    const doc = await ShopModel.findOneAndUpdate(
      { _id: shopId, deletedAt: null, 'members.userId': new Types.ObjectId(userId) },
      { $set: { 'members.$.role': role } },
      { new: true },
    ).lean<ShopDoc>();
    return doc ? toRecord(doc) : null;
  },

  async removeMember(
    shopId: string,
    userId: string,
    session: ClientSession,
  ): Promise<ShopRecord | null> {
    const doc = await ShopModel.findOneAndUpdate(
      { _id: shopId, deletedAt: null },
      { $pull: { members: { userId: new Types.ObjectId(userId) } } },
      { new: true, session },
    ).lean<ShopDoc>();
    return doc ? toRecord(doc) : null;
  },

  async softDelete(id: string, deletedBy: string, session: ClientSession): Promise<boolean> {
    const result = await ShopModel.updateOne(
      { _id: id, deletedAt: null },
      {
        $set: {
          deletedAt: new Date(),
          deletedBy: new Types.ObjectId(deletedBy),
          isVisible: false,
          visibilityReason: 'SHOP_NOT_ACTIVE',
        },
      },
      { session },
    );
    return result.modifiedCount === 1;
  },

  /**
   * Bulk visibility recomputation for a market. Used when a market is closed or reopened;
   * a market with thousands of shops must not become thousands of round trips.
   */
  async setVisibilityForMarket(
    marketId: string,
    isVisible: boolean,
    reason: string,
    session: ClientSession,
  ): Promise<number> {
    const result = await ShopModel.updateMany(
      { marketId, deletedAt: null },
      { $set: { isVisible, visibilityReason: reason, visibilityComputedAt: new Date() } },
      { session },
    );
    return result.modifiedCount;
  },

  async countVisibleInMarket(marketId: string): Promise<number> {
    return ShopModel.countDocuments({ marketId, isVisible: true, deletedAt: null });
  },
};
