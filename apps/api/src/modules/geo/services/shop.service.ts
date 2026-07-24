import mongoose from 'mongoose';
import { AppError, ErrorCode, notFound } from '@bozorlar/errors';
import type { Logger } from '@bozorlar/logger';
import {
  ActorType,
  AuditSeverity,
  ModerationStatus,
  ShopMemberRole,
  ShopStatus,
  type LocalizedText,
  type WorkingHoursEntry,
} from '@bozorlar/types';
import { userShopLinkService } from '../../identity/index.js';
import { outboxService } from '../../outbox/index.js';
import type { AuditService } from '../../audit/index.js';
import { CacheTag, type Cache } from '../../../shared/cache.js';
import { parseQuery, toPage, type Page, type QuerySpec } from '../../../http/query.js';
import { marketRepository } from '../repositories/market.repository.js';
import { shopRepository, type ShopRecord } from '../repositories/shop.repository.js';
import { computeShopVisibility, VisibilityReason } from '@bozorlar/domain';
import { assertValidWorkingHours, evaluateOpening, isValidTimezone } from './workingHours.service.js';
import { generateUniqueSlug } from './slug.js';
import { GeoEvents } from '../events.js';

export const SHOP_QUERY_SPEC: QuerySpec = {
  filters: [
    { field: 'marketId', type: 'objectId', operators: ['eq', 'in'] },
    { field: 'districtId', type: 'objectId', operators: ['eq', 'in'] },
    { field: 'regionId', type: 'objectId', operators: ['eq'] },
    { field: 'categoryId', type: 'objectId', operators: ['eq', 'in'], path: 'categoryIds' },
    { field: 'isVisible', type: 'boolean', operators: ['eq'] },
    { field: 'rating', type: 'number', operators: ['gte'], path: 'ratingBayesian' },
  ],
  sorts: [
    { key: '-rating', sort: { ratingBayesian: -1, _id: -1 } },
    { key: '-salesCount', sort: { salesCount: -1, _id: -1 } },
    { key: '-createdAt', sort: { createdAt: -1, _id: -1 } },
  ],
  defaultSort: '-rating',
};

export interface ShopView extends ShopRecord {
  isOpenNow: boolean;
  opensNextAt: string | null;
}

export interface CreateShopCommand {
  ownerId: string;
  marketId: string;
  name: LocalizedText;
  description?: LocalizedText | undefined;
  sectionCode?: string | undefined;
  stallNo?: string | undefined;
  contactPhone: string;
  categoryIds?: string[] | undefined;
  workingHours?: WorkingHoursEntry[] | undefined;
  location?: { lat: number; lng: number } | undefined;
}

/** Bazaar default: open every day 06:00–19:00. Sellers adjust from there. */
const DEFAULT_WORKING_HOURS: WorkingHoursEntry[] = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday: weekday as WorkingHoursEntry['weekday'],
  opensAt: '06:00',
  closesAt: '19:00',
  isClosed: false,
}));

export function createShopService(deps: { cache: Cache; audit: AuditService; logger: Logger }) {
  const { cache, audit, logger } = deps;

  function withOpeningState(shop: ShopRecord, now: Date): ShopView {
    const opening = evaluateOpening(shop.workingHours, shop.timezone, now);
    return {
      ...shop,
      isOpenNow: opening.isOpenNow,
      opensNextAt: opening.opensNextAt?.toISOString() ?? null,
    };
  }

  /**
   * Recomputes the materialized visibility flag from current inputs.
   *
   * Called inside the transaction that changed any input. Doing it eventually would leave a
   * window in which a suspended shop is still listed, which is a business-rule violation
   * rather than a staleness inconvenience (MARKET_SYSTEM.md).
   */
  async function recomputeVisibility(
    shop: ShopRecord,
    session: mongoose.ClientSession,
  ): Promise<ShopRecord> {
    const market = await marketRepository.findByIdOrSlug(shop.marketId);
    if (!market) throw notFound('Market');

    const result = computeShopVisibility({
      shopStatus: shop.status,
      moderationStatus: shop.moderationStatus,
      marketStatus: market.status,
      sellerWalletActive: shop.sellerWalletActive,
      vacationUntil: shop.vacationUntil,
      now: new Date(),
    });

    if (result.isVisible === shop.isVisible && result.reason === shop.visibilityReason) {
      return shop;
    }

    const updated = await shopRepository.update(
      shop.id,
      {
        isVisible: result.isVisible,
        visibilityReason: result.reason,
        visibilityComputedAt: new Date(),
      },
      session,
    );
    if (!updated) throw notFound('Shop');

    await outboxService.publish(
      {
        type: GeoEvents.SHOP_VISIBILITY_CHANGED,
        aggregateType: 'shop',
        aggregateId: shop.id,
        payload: { shopId: shop.id, isVisible: result.isVisible, reason: result.reason },
      },
      session,
    );
    return updated;
  }

  async function purgeShopCaches(shop: ShopRecord): Promise<void> {
    await cache.invalidateTags(CacheTag.shop(shop.id), CacheTag.shopsOfMarket(shop.marketId));
  }

  return {
    async create(command: CreateShopCommand): Promise<ShopView> {
      const market = await marketRepository.findByIdOrSlug(command.marketId);
      if (!market) throw notFound('Market');
      if (market.status !== 'ACTIVE') {
        throw new AppError(ErrorCode.RESOURCE_CONFLICT, {
          detail: 'Cannot open a shop in a market that is not active',
        });
      }

      const workingHours = command.workingHours ?? DEFAULT_WORKING_HOURS;
      try {
        assertValidWorkingHours(workingHours);
      } catch (cause) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, {
          detail: cause instanceof Error ? cause.message : 'Invalid working hours',
          errors: [{ field: 'workingHours', code: 'INVALID_SCHEDULE' }],
        });
      }

      if (command.sectionCode && command.stallNo) {
        const taken = await shopRepository.stallTaken(
          market.id,
          command.sectionCode,
          command.stallNo,
        );
        if (taken) {
          throw new AppError(ErrorCode.RESOURCE_CONFLICT, {
            detail: `Stall ${command.sectionCode}-${command.stallNo} is already registered in this market`,
            errors: [{ field: 'stallNo', code: 'STALL_TAKEN' }],
          });
        }
      }
      if (command.sectionCode && market.sections.length > 0) {
        const known = market.sections.some((section) => section.code === command.sectionCode);
        if (!known) {
          throw new AppError(ErrorCode.VALIDATION_FAILED, {
            detail: `Section "${command.sectionCode}" does not exist in this market`,
            errors: [{ field: 'sectionCode', code: 'UNKNOWN_SECTION' }],
          });
        }
      }

      const slug = await generateUniqueSlug(command.name.uz, (candidate) =>
        shopRepository.slugExists(candidate),
      );

      const session = await mongoose.startSession();
      let created: ShopRecord;
      try {
        created = await session.withTransaction(async () => {
          const shop = await shopRepository.create(
            {
              ownerId: command.ownerId,
              marketId: market.id,
              districtId: market.districtId,
              regionId: market.regionId,
              name: command.name,
              slug,
              description: command.description ?? null,
              sectionCode: command.sectionCode ?? null,
              stallNo: command.stallNo ?? null,
              contactPhone: command.contactPhone,
              categoryIds: command.categoryIds ?? [],
              workingHours,
              timezone: market.timezone,
              location: command.location ?? null,
            },
            session,
          );

          // The owner's shopIds and seller role must land in the same transaction, or the
          // owner is briefly unable to act on the shop they just created.
          await userShopLinkService.attachShop(
            command.ownerId,
            shop.id,
            { grantSellerRole: true },
            session,
          );
          await marketRepository.incrementShopCount(market.id, 1, session);

          await outboxService.publish(
            {
              type: GeoEvents.SHOP_CREATED,
              aggregateType: 'shop',
              aggregateId: shop.id,
              payload: { shopId: shop.id, marketId: market.id, ownerId: command.ownerId },
              actorId: command.ownerId,
              actorType: ActorType.USER,
            },
            session,
          );

          return shop;
        });
      } finally {
        await session.endSession();
      }

      await audit.record({
        actorId: command.ownerId,
        actorType: ActorType.USER,
        action: 'shop.created',
        targetType: 'shop',
        targetId: created.id,
        after: { marketId: market.id, slug },
      });
      await cache.invalidateTags(CacheTag.shopsOfMarket(market.id), CacheTag.marketList());
      logger.info({ shopId: created.id, marketId: market.id }, 'shop created');

      return withOpeningState(created, new Date());
    },

    async getPublic(idOrSlug: string): Promise<ShopView> {
      const shop = await shopRepository.findByIdOrSlug(idOrSlug);
      // A shop that is not visible is reported as missing rather than as forbidden, so the
      // public API cannot be used to discover suspended or unmoderated shops (ADR-0029).
      if (!shop || !shop.isVisible) {
        throw notFound('Shop', shop ? `SHOP_NOT_VISIBLE reason=${shop.visibilityReason}` : undefined);
      }
      return withOpeningState(shop, new Date());
    },

    async getForMember(shopId: string, actorShopIds: readonly string[]): Promise<ShopView> {
      if (!actorShopIds.includes(shopId)) throw notFound('Shop', 'PERM_SCOPE_DENIED');
      const shop = await shopRepository.findById(shopId);
      if (!shop) throw notFound('Shop');
      return withOpeningState(shop, new Date());
    },

    async listPublic(query: Record<string, unknown>): Promise<Page<ShopView>> {
      // isVisible is forced rather than defaulted: a caller must not be able to pass
      // ?isVisible=false and enumerate hidden shops.
      const parsed = parseQuery({ ...query, isVisible: 'true' }, SHOP_QUERY_SPEC);
      const rows = await shopRepository.list(parsed);
      const page = toPage(rows as unknown as Record<string, unknown>[], parsed);
      const now = new Date();
      return {
        items: (page.items as unknown as ShopRecord[]).map((shop) => withOpeningState(shop, now)),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      };
    },

    async listForUser(userId: string): Promise<ShopView[]> {
      const shops = await shopRepository.listForUser(userId);
      const now = new Date();
      return shops.map((shop) => withOpeningState(shop, now));
    },

    async update(
      shopId: string,
      actor: { userId: string; shopIds: readonly string[] },
      patch: {
        name?: LocalizedText;
        description?: LocalizedText;
        contactPhone?: string;
        sectionCode?: string;
        stallNo?: string;
        categoryIds?: string[];
      },
    ): Promise<ShopView> {
      if (!actor.shopIds.includes(shopId)) throw notFound('Shop', 'PERM_SCOPE_DENIED');
      const existing = await shopRepository.findById(shopId);
      if (!existing) throw notFound('Shop');

      // Editing the displayed identity of an approved shop returns it to moderation; price
      // and stock edits deliberately do not (MODERATION.md).
      const requiresRemoderation =
        patch.name !== undefined && existing.moderationStatus === ModerationStatus.APPROVED;

      const session = await mongoose.startSession();
      let updated: ShopRecord;
      try {
        updated = await session.withTransaction(async () => {
          const next = await shopRepository.update(
            shopId,
            {
              ...patch,
              ...(requiresRemoderation
                ? { moderationStatus: ModerationStatus.PENDING, moderationReason: null }
                : {}),
            },
            session,
          );
          if (!next) throw notFound('Shop');

          const visible = await recomputeVisibility(next, session);
          await outboxService.publish(
            {
              type: GeoEvents.SHOP_UPDATED,
              aggregateType: 'shop',
              aggregateId: shopId,
              payload: { shopId, fields: Object.keys(patch), requiresRemoderation },
              actorId: actor.userId,
              actorType: ActorType.USER,
            },
            session,
          );
          return visible;
        });
      } finally {
        await session.endSession();
      }

      await audit.record({
        actorId: actor.userId,
        actorType: ActorType.USER,
        action: 'shop.updated',
        targetType: 'shop',
        targetId: shopId,
        before: { name: existing.name, moderationStatus: existing.moderationStatus },
        after: { name: updated.name, moderationStatus: updated.moderationStatus },
      });
      await purgeShopCaches(updated);
      return withOpeningState(updated, new Date());
    },

    async setWorkingHours(
      shopId: string,
      actor: { userId: string; shopIds: readonly string[] },
      workingHours: WorkingHoursEntry[],
      timezone?: string,
    ): Promise<ShopView> {
      if (!actor.shopIds.includes(shopId)) throw notFound('Shop', 'PERM_SCOPE_DENIED');
      try {
        assertValidWorkingHours(workingHours);
      } catch (cause) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, {
          detail: cause instanceof Error ? cause.message : 'Invalid working hours',
          errors: [{ field: 'workingHours', code: 'INVALID_SCHEDULE' }],
        });
      }
      if (timezone !== undefined && !isValidTimezone(timezone)) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, {
          detail: `"${timezone}" is not a valid IANA timezone`,
          errors: [{ field: 'timezone', code: 'INVALID_TIMEZONE' }],
        });
      }

      const updated = await shopRepository.update(shopId, {
        workingHours,
        ...(timezone !== undefined ? { timezone } : {}),
      });
      if (!updated) throw notFound('Shop');
      await purgeShopCaches(updated);
      return withOpeningState(updated, new Date());
    },

    /**
     * Vacation mode hides the shop immediately. Visibility is recomputed in the same
     * transaction rather than waiting for a sweeper, because a seller who switches it on is
     * usually about to stop answering the phone.
     */
    async setVacation(
      shopId: string,
      actor: { userId: string; shopIds: readonly string[] },
      until: Date | null,
    ): Promise<ShopView> {
      if (!actor.shopIds.includes(shopId)) throw notFound('Shop', 'PERM_SCOPE_DENIED');
      if (until !== null && until.getTime() <= Date.now()) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, {
          detail: 'Vacation end must be in the future',
          errors: [{ field: 'until', code: 'MUST_BE_FUTURE' }],
        });
      }

      const session = await mongoose.startSession();
      let updated: ShopRecord;
      try {
        updated = await session.withTransaction(async () => {
          const next = await shopRepository.update(shopId, { vacationUntil: until }, session);
          if (!next) throw notFound('Shop');
          return recomputeVisibility(next, session);
        });
      } finally {
        await session.endSession();
      }

      await audit.record({
        actorId: actor.userId,
        actorType: ActorType.USER,
        action: until ? 'shop.vacation_started' : 'shop.vacation_ended',
        targetType: 'shop',
        targetId: shopId,
        after: { vacationUntil: until?.toISOString() ?? null },
      });
      await purgeShopCaches(updated);
      return withOpeningState(updated, new Date());
    },

    async addMember(
      shopId: string,
      actor: { userId: string; shopIds: readonly string[] },
      input: { phone: string; role: ShopMemberRole },
    ): Promise<ShopView> {
      if (!actor.shopIds.includes(shopId)) throw notFound('Shop', 'PERM_SCOPE_DENIED');
      const shop = await shopRepository.findById(shopId);
      if (!shop) throw notFound('Shop');
      if (shop.ownerId !== actor.userId) {
        throw new AppError(ErrorCode.PERM_DENIED, { detail: 'Only the shop owner can manage staff' });
      }
      if (input.role === ShopMemberRole.OWNER) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, {
          detail: 'A shop has exactly one owner; transfer ownership instead',
          errors: [{ field: 'role', code: 'OWNER_NOT_ASSIGNABLE' }],
        });
      }
      if (shop.members.length >= 20) {
        throw new AppError(ErrorCode.RESOURCE_CONFLICT, { detail: 'A shop may have at most 20 members' });
      }

      const memberId = await userShopLinkService.findActiveIdByPhone(input.phone);
      // Reported as missing rather than "no such user", so the endpoint cannot be used to
      // test which phone numbers are registered (ADR-0029).
      if (!memberId) throw notFound('User', `MEMBER_PHONE_NOT_FOUND phone=${input.phone}`);
      if (shop.members.some((member) => member.userId === memberId)) {
        throw new AppError(ErrorCode.RESOURCE_CONFLICT, { detail: 'This user is already a member' });
      }

      const session = await mongoose.startSession();
      let updated: ShopRecord;
      try {
        updated = await session.withTransaction(async () => {
          const next = await shopRepository.addMember(
            shopId,
            { userId: memberId, role: input.role, addedBy: actor.userId },
            session,
          );
          if (!next) throw new AppError(ErrorCode.RESOURCE_CONFLICT, { detail: 'Member already added' });

          await userShopLinkService.attachShop(
            memberId,
            shopId,
            { grantSellerRole: false },
            session,
          );
          await outboxService.publish(
            {
              type: GeoEvents.SHOP_MEMBER_ADDED,
              aggregateType: 'shop',
              aggregateId: shopId,
              payload: { shopId, userId: memberId, role: input.role },
              actorId: actor.userId,
              actorType: ActorType.USER,
            },
            session,
          );
          return next;
        });
      } finally {
        await session.endSession();
      }

      await audit.record({
        actorId: actor.userId,
        actorType: ActorType.USER,
        action: 'shop.member_added',
        targetType: 'shop',
        targetId: shopId,
        after: { userId: memberId, role: input.role },
        severity: AuditSeverity.WARNING,
      });
      return withOpeningState(updated, new Date());
    },

    async removeMember(
      shopId: string,
      actor: { userId: string; shopIds: readonly string[] },
      memberUserId: string,
    ): Promise<ShopView> {
      if (!actor.shopIds.includes(shopId)) throw notFound('Shop', 'PERM_SCOPE_DENIED');
      const shop = await shopRepository.findById(shopId);
      if (!shop) throw notFound('Shop');
      if (shop.ownerId !== actor.userId) {
        throw new AppError(ErrorCode.PERM_DENIED, { detail: 'Only the shop owner can manage staff' });
      }
      if (memberUserId === shop.ownerId) {
        throw new AppError(ErrorCode.RESOURCE_CONFLICT, {
          detail: 'The owner cannot be removed; transfer ownership or close the shop',
        });
      }
      if (!shop.members.some((member) => member.userId === memberUserId)) {
        throw notFound('Member');
      }

      const session = await mongoose.startSession();
      let updated: ShopRecord;
      try {
        updated = await session.withTransaction(async () => {
          const next = await shopRepository.removeMember(shopId, memberUserId, session);
          if (!next) throw notFound('Shop');
          await userShopLinkService.detachShop(memberUserId, shopId, session);
          await outboxService.publish(
            {
              type: GeoEvents.SHOP_MEMBER_REMOVED,
              aggregateType: 'shop',
              aggregateId: shopId,
              payload: { shopId, userId: memberUserId },
              actorId: actor.userId,
              actorType: ActorType.USER,
            },
            session,
          );
          return next;
        });
      } finally {
        await session.endSession();
      }

      await audit.record({
        actorId: actor.userId,
        actorType: ActorType.USER,
        action: 'shop.member_removed',
        targetType: 'shop',
        targetId: shopId,
        before: { userId: memberUserId },
        severity: AuditSeverity.WARNING,
      });
      return withOpeningState(updated, new Date());
    },

    /**
     * Moderation decision. Approving is what actually publishes a shop, so visibility is
     * recomputed in the same transaction as the decision.
     */
    async moderate(
      shopId: string,
      moderatorId: string,
      decision: { approved: boolean; reason?: string | undefined },
    ): Promise<ShopView> {
      const shop = await shopRepository.findById(shopId);
      if (!shop) throw notFound('Shop');
      if (!decision.approved && !decision.reason) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, {
          detail: 'A rejection reason is required',
          errors: [{ field: 'reason', code: 'REQUIRED' }],
        });
      }

      const session = await mongoose.startSession();
      let updated: ShopRecord;
      try {
        updated = await session.withTransaction(async () => {
          const next = await shopRepository.update(
            shopId,
            {
              moderationStatus: decision.approved
                ? ModerationStatus.APPROVED
                : ModerationStatus.REJECTED,
              moderationReason: decision.reason ?? null,
              ...(decision.approved && shop.status === ShopStatus.DRAFT
                ? { status: ShopStatus.ACTIVE }
                : {}),
            },
            session,
          );
          if (!next) throw notFound('Shop');

          const visible = await recomputeVisibility(next, session);
          await outboxService.publish(
            {
              type: GeoEvents.SHOP_MODERATION_DECIDED,
              aggregateType: 'shop',
              aggregateId: shopId,
              payload: { shopId, approved: decision.approved, reason: decision.reason ?? null },
              actorId: moderatorId,
              actorType: ActorType.ADMIN,
            },
            session,
          );
          return visible;
        });
      } finally {
        await session.endSession();
      }

      await audit.record({
        actorId: moderatorId,
        actorType: ActorType.ADMIN,
        action: decision.approved ? 'shop.moderation_approved' : 'shop.moderation_rejected',
        targetType: 'shop',
        targetId: shopId,
        reason: decision.reason ?? null,
        before: { moderationStatus: shop.moderationStatus, isVisible: shop.isVisible },
        after: { moderationStatus: updated.moderationStatus, isVisible: updated.isVisible },
        severity: AuditSeverity.WARNING,
      });
      await purgeShopCaches(updated);
      return withOpeningState(updated, new Date());
    },

    async close(
      shopId: string,
      actor: { userId: string; shopIds: readonly string[] },
    ): Promise<void> {
      if (!actor.shopIds.includes(shopId)) throw notFound('Shop', 'PERM_SCOPE_DENIED');
      const shop = await shopRepository.findById(shopId);
      if (!shop) throw notFound('Shop');
      if (shop.ownerId !== actor.userId) {
        throw new AppError(ErrorCode.PERM_DENIED, { detail: 'Only the shop owner can close a shop' });
      }

      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const closed = await shopRepository.softDelete(shopId, actor.userId, session);
          if (!closed) throw notFound('Shop');
          for (const member of shop.members) {
            await userShopLinkService.detachShop(member.userId, shopId, session);
          }
          await marketRepository.incrementShopCount(shop.marketId, -1, session);
          await outboxService.publish(
            {
              type: GeoEvents.SHOP_VISIBILITY_CHANGED,
              aggregateType: 'shop',
              aggregateId: shopId,
              payload: { shopId, isVisible: false, reason: VisibilityReason.SHOP_NOT_ACTIVE },
              actorId: actor.userId,
              actorType: ActorType.USER,
            },
            session,
          );
        });
      } finally {
        await session.endSession();
      }

      await audit.record({
        actorId: actor.userId,
        actorType: ActorType.USER,
        action: 'shop.closed',
        targetType: 'shop',
        targetId: shopId,
        severity: AuditSeverity.WARNING,
      });
      await purgeShopCaches(shop);
    },

    /**
     * Internal lookup for other modules: a shop's geography and current visibility.
     *
     * Performs no authorisation, deliberately — the caller has already checked that the
     * actor owns the shop. Exposing it as a distinct method keeps that assumption explicit,
     * instead of callers passing a shop's own id as its scope to slip past `getForMember`.
     */
    async findContext(shopId: string) {
      const shop = await shopRepository.findById(shopId);
      if (!shop) return null;
      const market = (await marketRepository.findManyByIds([shop.marketId])).get(shop.marketId);
      return {
        id: shop.id,
        ownerId: shop.ownerId,
        name: shop.name,
        slug: shop.slug,
        contactPhone: shop.contactPhone,
        sectionCode: shop.sectionCode,
        stallNo: shop.stallNo,
        marketId: shop.marketId,
        marketName: market?.name ?? shop.name,
        districtId: shop.districtId,
        regionId: shop.regionId,
        isVisible: shop.isVisible,
      };
    },

    /**
     * Batch shop and market detail for a checkout quote.
     *
     * A quote is grouped by shop (ADR-0007) and each group shows the shop, its market and a
     * pickup window, so the opening hours come back with it rather than in a second call.
     */
    async findCheckoutSummaries(shopIds: readonly string[]) {
      const summaries = new Map<
        string,
        {
          id: string;
          name: LocalizedText;
          marketId: string;
          marketName: LocalizedText;
          isVisible: boolean;
          workingHours: WorkingHoursEntry[];
          timezone: string;
        }
      >();
      if (shopIds.length === 0) return summaries;

      const shops = await Promise.all(shopIds.map((id) => shopRepository.findById(id)));
      const found = shops.filter((shop): shop is NonNullable<typeof shop> => shop !== null);
      const markets = await marketRepository.findManyByIds([
        ...new Set(found.map((shop) => shop.marketId)),
      ]);

      for (const shop of found) {
        const market = markets.get(shop.marketId);
        if (!market) continue;
        summaries.set(shop.id, {
          id: shop.id,
          name: shop.name,
          marketId: market.id,
          marketName: market.name,
          isVisible: shop.isVisible,
          workingHours: shop.workingHours,
          timezone: shop.timezone,
        });
      }
      return summaries;
    },

    /** Exposed for the market service; keeps the visibility rule in one place. */
    recomputeVisibility,
  };
}

export type ShopService = ReturnType<typeof createShopService>;
