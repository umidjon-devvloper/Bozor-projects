import mongoose from 'mongoose';
import { AppError, ErrorCode, notFound } from '@bozorlar/errors';
import type { Logger } from '@bozorlar/logger';
import {
  ActorType,
  AuditSeverity,
  MarketStatus,
  type LocalizedText,
  type WorkingHoursEntry,
} from '@bozorlar/types';
import { geoRepository } from '../repositories/geo.repository.js';
import { marketRepository, type MarketRecord } from '../repositories/market.repository.js';
import { shopRepository } from '../repositories/shop.repository.js';
import { outboxService } from '../../outbox/index.js';
import type { AuditService } from '../../audit/index.js';
import { CacheTag, type Cache } from '../../../shared/cache.js';
import { assertValidWorkingHours, isValidTimezone } from './workingHours.service.js';
import { generateUniqueSlug } from './slug.js';
import { VisibilityReason } from '@bozorlar/domain';
import { GeoEvents } from '../events.js';

export interface CreateMarketCommand {
  districtId: string;
  name: LocalizedText;
  address: LocalizedText;
  description?: LocalizedText | undefined;
  location: { lat: number; lng: number };
  workingHours: WorkingHoursEntry[];
  timezone?: string | undefined;
  contactPhone?: string | undefined;
  sections?: Array<{ code: string; name: LocalizedText }> | undefined;
}

export function createMarketService(deps: { cache: Cache; audit: AuditService; logger: Logger }) {
  const { cache, audit, logger } = deps;

  function validateSchedule(workingHours: WorkingHoursEntry[], timezone?: string): void {
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
  }

  return {
    async create(command: CreateMarketCommand, actorId: string): Promise<MarketRecord> {
      const district = await geoRepository.findDistrict(command.districtId);
      if (!district) throw notFound('District');
      validateSchedule(command.workingHours, command.timezone);

      const sectionCodes = (command.sections ?? []).map((section) => section.code);
      if (new Set(sectionCodes).size !== sectionCodes.length) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, {
          detail: 'Section codes must be unique within a market',
          errors: [{ field: 'sections', code: 'DUPLICATE_CODE' }],
        });
      }

      const slug = await generateUniqueSlug(command.name.uz, (candidate) =>
        marketRepository.slugExists(candidate),
      );

      const session = await mongoose.startSession();
      let marketId: string;
      try {
        marketId = await session.withTransaction(async () => {
          const id = await marketRepository.create(
            {
              districtId: new mongoose.Types.ObjectId(district.id),
              regionId: new mongoose.Types.ObjectId(district.regionId),
              name: command.name,
              slug,
              description: command.description ?? null,
              address: command.address,
              location: {
                type: 'Point' as const,
                coordinates: [command.location.lng, command.location.lat],
              },
              workingHours: command.workingHours,
              timezone: command.timezone ?? 'Asia/Tashkent',
              contactPhone: command.contactPhone ?? null,
              sections: command.sections ?? [],
            },
            session,
          );

          await outboxService.publish(
            {
              type: GeoEvents.MARKET_CREATED,
              aggregateType: 'market',
              aggregateId: id,
              payload: { marketId: id, districtId: district.id, slug },
              actorId,
              actorType: ActorType.ADMIN,
            },
            session,
          );
          return id;
        });
      } finally {
        await session.endSession();
      }

      await geoRepository.incrementMarketCount(district.id, 1);
      await cache.invalidateTags(CacheTag.marketList(), CacheTag.districts(district.regionId));
      await audit.record({
        actorId,
        actorType: ActorType.ADMIN,
        action: 'market.created',
        targetType: 'market',
        targetId: marketId,
        after: { slug, districtId: district.id },
      });
      logger.info({ marketId, slug }, 'market created');

      const created = await marketRepository.findByIdOrSlug(marketId);
      if (!created) throw notFound('Market');
      return created;
    },

    async update(
      marketId: string,
      actorId: string,
      patch: {
        name?: LocalizedText;
        description?: LocalizedText;
        address?: LocalizedText;
        contactPhone?: string;
        workingHours?: WorkingHoursEntry[];
        timezone?: string;
        sections?: Array<{ code: string; name: LocalizedText }>;
      },
    ): Promise<MarketRecord> {
      const existing = await marketRepository.findByIdOrSlug(marketId);
      if (!existing) throw notFound('Market');
      if (patch.workingHours) validateSchedule(patch.workingHours, patch.timezone);

      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          await marketRepository.applyPatch(existing.id, patch, session);
          await outboxService.publish(
            {
              type: GeoEvents.MARKET_UPDATED,
              aggregateType: 'market',
              aggregateId: existing.id,
              payload: { marketId: existing.id, fields: Object.keys(patch) },
              actorId,
              actorType: ActorType.ADMIN,
            },
            session,
          );
        });
      } finally {
        await session.endSession();
      }

      await cache.invalidateTags(CacheTag.marketList(), CacheTag.market(existing.id));
      await audit.record({
        actorId,
        actorType: ActorType.ADMIN,
        action: 'market.updated',
        targetType: 'market',
        targetId: existing.id,
        after: { fields: Object.keys(patch) },
      });

      const updated = await marketRepository.findByIdOrSlug(existing.id);
      if (!updated) throw notFound('Market');
      return updated;
    },

    /**
     * Changing market status cascades to every shop inside it.
     *
     * The cascade is a single `updateMany` rather than a loop: a large bazaar has thousands
     * of stalls, and closing it must not become thousands of round trips inside one
     * transaction. Correctness is preserved because the market status is the only visibility
     * input that changed, so the resulting flag is identical for all of them.
     */
    async setStatus(
      marketId: string,
      actorId: string,
      status: MarketStatus,
      reason: string,
    ): Promise<{ market: MarketRecord; shopsAffected: number }> {
      const existing = await marketRepository.findByIdOrSlug(marketId);
      if (!existing) throw notFound('Market');
      if (existing.status === status) {
        throw new AppError(ErrorCode.RESOURCE_CONFLICT, {
          detail: `Market is already ${status}`,
        });
      }

      const session = await mongoose.startSession();
      let shopsAffected = 0;
      try {
        shopsAffected = await session.withTransaction(async () => {
          await marketRepository.setStatus(existing.id, status, session);

          const affected =
            status === MarketStatus.ACTIVE
              ? 0 // Reopening cannot blanket-set visible: each shop's own inputs still apply.
              : await shopRepository.setVisibilityForMarket(
                  existing.id,
                  false,
                  VisibilityReason.MARKET_NOT_ACTIVE,
                  session,
                );

          await outboxService.publish(
            {
              type: GeoEvents.MARKET_STATUS_CHANGED,
              aggregateType: 'market',
              aggregateId: existing.id,
              payload: { marketId: existing.id, from: existing.status, to: status, reason },
              actorId,
              actorType: ActorType.ADMIN,
            },
            session,
          );
          return affected;
        });
      } finally {
        await session.endSession();
      }

      await cache.invalidateTags(
        CacheTag.marketList(),
        CacheTag.market(existing.id),
        CacheTag.shopsOfMarket(existing.id),
      );
      await audit.record({
        actorId,
        actorType: ActorType.ADMIN,
        action: 'market.status_changed',
        targetType: 'market',
        targetId: existing.id,
        before: { status: existing.status },
        after: { status, shopsAffected },
        reason,
        severity: AuditSeverity.CRITICAL,
      });
      logger.warn({ marketId: existing.id, status, shopsAffected }, 'market status changed');

      const updated = await marketRepository.findByIdOrSlug(existing.id);
      if (!updated) throw notFound('Market');
      return { market: updated, shopsAffected };
    },
  };
}

export type MarketService = ReturnType<typeof createMarketService>;
