import mongoose from 'mongoose';
import { AppError, ErrorCode, notFound } from '@bozorlar/errors';
import type { Logger } from '@bozorlar/logger';
import { ActorType, AuditSeverity, type LocalizedText } from '@bozorlar/types';
import { blindIndex, decryptField, encryptField, maskDocumentNumber } from '../../../shared/crypto.js';
import { outboxService } from '../../outbox/index.js';
import type { AuditService } from '../../audit/index.js';
import { MediaPurpose, type MediaService } from '../../media/index.js';
import { userShopLinkService } from '../../identity/index.js';
import { parseQuery, toPage, type Page, type QuerySpec } from '../../../http/query.js';
import {
  APPLICATION_TRANSITIONS,
  ApplicationStatus,
  DocumentType,
  MAX_DOCUMENTS,
  MAX_RESUBMISSIONS,
  REQUIRED_DOCUMENTS,
  REVIEW_SLA_HOURS,
  type RejectionReasonCode,
} from '../onboarding.constants.js';
import {
  sellerApplicationRepository,
  type ApplicationRecord,
} from '../repositories/sellerApplication.repository.js';
import { normaliseIdentityDocuments } from './identityDocuments.service.js';
import { OnboardingEvents } from '../events.js';

export const APPLICATION_QUERY_SPEC: QuerySpec = {
  filters: [
    { field: 'status', type: 'string', operators: ['eq', 'in'] },
    { field: 'marketId', type: 'objectId', operators: ['eq', 'in'] },
    { field: 'reviewerId', type: 'objectId', operators: ['eq'] },
    { field: 'submittedAt', type: 'date', operators: ['gte', 'lte'] },
  ],
  sorts: [
    { key: 'submittedAt', sort: { submittedAt: 1, _id: 1 } },
    { key: '-submittedAt', sort: { submittedAt: -1, _id: -1 } },
    { key: '-createdAt', sort: { createdAt: -1, _id: -1 } },
  ],
  defaultSort: 'submittedAt',
};

export interface SubmitApplicationCommand {
  userId: string;
  marketId: string;
  shopName: LocalizedText;
  contactPhone: string;
  passportSeries: string;
  passportNumber: string;
  stir: string;
  documents: Array<{ type: DocumentType; mediaKey: string }>;
}

export interface MarketLookup {
  exists(marketId: string): Promise<boolean>;
}

export interface RevealedIdentity {
  passportSeries: string;
  passportNumber: string;
  stir: string;
}

function assertTransition(from: ApplicationStatus, to: ApplicationStatus): void {
  if (!APPLICATION_TRANSITIONS[from].includes(to)) {
    throw new AppError(ErrorCode.RESOURCE_CONFLICT, {
      detail: `An application cannot move from ${from} to ${to}`,
      params: { from, to, allowed: APPLICATION_TRANSITIONS[from] },
    });
  }
}

export function createOnboardingService(deps: {
  media: MediaService;
  markets: MarketLookup;
  audit: AuditService;
  logger: Logger;
}) {
  const { media, markets, audit, logger } = deps;

  function assertDocumentsComplete(
    documents: ReadonlyArray<{ type: DocumentType; mediaKey: string }>,
  ): void {
    if (documents.length > MAX_DOCUMENTS) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        detail: `At most ${MAX_DOCUMENTS} documents may be attached`,
      });
    }
    const provided = new Set(documents.map((document) => document.type));
    const missing = REQUIRED_DOCUMENTS.filter((required) => !provided.has(required));
    if (missing.length > 0) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        detail: 'Required documents are missing',
        errors: missing.map((type) => ({ field: 'documents', code: 'MISSING_DOCUMENT', params: { type } })),
      });
    }
    const keys = documents.map((document) => document.mediaKey);
    if (new Set(keys).size !== keys.length) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        detail: 'The same file cannot be attached twice',
        errors: [{ field: 'documents', code: 'DUPLICATE_MEDIA_KEY' }],
      });
    }
  }

  function encryptIdentity(command: SubmitApplicationCommand) {
    const identity = normaliseIdentityDocuments({
      passportSeries: command.passportSeries,
      passportNumber: command.passportNumber,
      stir: command.stir,
    });
    return {
      identity,
      secrets: {
        passportSeriesEncrypted: encryptField(identity.passportSeries),
        passportNumberEncrypted: encryptField(identity.passportNumber),
        passportBlindIndex: blindIndex(identity.passportFull),
        stirEncrypted: encryptField(identity.stir),
        stirBlindIndex: blindIndex(identity.stir),
      },
    };
  }

  /**
   * Refuses an identity already approved for a different account.
   *
   * The unique partial indexes on the blind indexes are the real guarantee; this check exists
   * so the applicant gets a comprehensible error instead of a duplicate-key failure, and so
   * the attempt is recorded for fraud review.
   */
  async function assertIdentityNotAlreadyApproved(
    secrets: { passportBlindIndex: string; stirBlindIndex: string },
    userId: string,
  ): Promise<void> {
    const existing = await sellerApplicationRepository.findApprovedByIdentity({
      passportBlindIndex: secrets.passportBlindIndex,
      stirBlindIndex: secrets.stirBlindIndex,
      excludeUserId: userId,
    });
    if (!existing) return;

    await audit.record({
      actorId: userId,
      actorType: ActorType.USER,
      action: 'onboarding.duplicate_identity_attempt',
      targetType: 'seller_application',
      targetId: existing.id,
      after: { matchedOn: existing.matchedOn, existingUserId: existing.userId },
      severity: AuditSeverity.CRITICAL,
    });

    throw new AppError(ErrorCode.RESOURCE_CONFLICT, {
      detail:
        existing.matchedOn === 'PASSPORT'
          ? 'These identity documents are already registered to another seller account'
          : 'This taxpayer number is already registered to another seller account',
      params: { matchedOn: existing.matchedOn },
    });
  }

  return {
    async submit(command: SubmitApplicationCommand): Promise<ApplicationRecord> {
      if (!(await markets.exists(command.marketId))) throw notFound('Market');

      const existing = await sellerApplicationRepository.findActiveForUser(command.userId);
      if (existing) {
        throw new AppError(ErrorCode.RESOURCE_CONFLICT, {
          detail: 'You already have an application in progress',
          params: { applicationId: existing.id, status: existing.status },
        });
      }

      assertDocumentsComplete(command.documents);
      const { secrets } = encryptIdentity(command);
      await assertIdentityNotAlreadyApproved(secrets, command.userId);

      const now = new Date();
      const documents = command.documents.map((document) => ({ ...document, uploadedAt: now }));
      const slaDueAt = new Date(now.getTime() + REVIEW_SLA_HOURS * 60 * 60 * 1000);

      const session = await mongoose.startSession();
      let created: ApplicationRecord;
      try {
        created = await session.withTransaction(async () => {
          const application = await sellerApplicationRepository.create(
            {
              userId: command.userId,
              marketId: command.marketId,
              shopName: command.shopName,
              contactPhone: command.contactPhone,
              documents,
              secrets,
              status: ApplicationStatus.SUBMITTED,
              submittedAt: now,
              reviewSlaDueAt: slaDueAt,
            },
            session,
          );

          // Attaching inside the transaction is what stops the orphan sweeper reclaiming a
          // passport scan out from under an application that has just been filed.
          await media.attachToEntity({
            mediaKeys: documents.map((document) => document.mediaKey),
            target: { type: 'seller_application', id: application.id },
            expectedPurpose: MediaPurpose.KYC_DOCUMENT,
            ownerId: command.userId,
            session,
          });

          await outboxService.publish(
            {
              type: OnboardingEvents.APPLICATION_SUBMITTED,
              aggregateType: 'seller_application',
              aggregateId: application.id,
              payload: { applicationId: application.id, userId: command.userId, marketId: command.marketId },
              actorId: command.userId,
              actorType: ActorType.USER,
            },
            session,
          );

          return application;
        });
      } finally {
        await session.endSession();
      }

      await audit.record({
        actorId: command.userId,
        actorType: ActorType.USER,
        action: 'onboarding.submitted',
        targetType: 'seller_application',
        targetId: created.id,
        after: { marketId: command.marketId, documentCount: documents.length },
      });
      logger.info({ applicationId: created.id, userId: command.userId }, 'seller application submitted');
      return created;
    },

    async resubmit(
      applicationId: string,
      command: SubmitApplicationCommand,
    ): Promise<ApplicationRecord> {
      const existing = await sellerApplicationRepository.findById(applicationId);
      if (!existing) throw notFound('Application');
      if (existing.userId !== command.userId) {
        throw notFound('Application', `PERM_SCOPE_DENIED user=${command.userId}`);
      }
      if (existing.status !== ApplicationStatus.REJECTED) {
        throw new AppError(ErrorCode.RESOURCE_CONFLICT, {
          detail: `Only a rejected application can be resubmitted (current status: ${existing.status})`,
        });
      }
      if (existing.resubmissionCount >= MAX_RESUBMISSIONS) {
        throw new AppError(ErrorCode.RESOURCE_CONFLICT, {
          detail: 'This application has been resubmitted the maximum number of times; contact support',
          params: { maxResubmissions: MAX_RESUBMISSIONS },
        });
      }
      if (!(await markets.exists(command.marketId))) throw notFound('Market');

      assertDocumentsComplete(command.documents);
      const { secrets } = encryptIdentity(command);
      await assertIdentityNotAlreadyApproved(secrets, command.userId);

      const now = new Date();
      const documents = command.documents.map((document) => ({ ...document, uploadedAt: now }));

      const session = await mongoose.startSession();
      let updated: ApplicationRecord;
      try {
        updated = await session.withTransaction(async () => {
          // Previously attached files are released first, so replaced documents become
          // eligible for reclamation instead of lingering forever.
          await media.detachFromEntity({ type: 'seller_application', id: applicationId }, session);

          const next = await sellerApplicationRepository.replaceForResubmission(
            applicationId,
            {
              marketId: command.marketId,
              shopName: command.shopName,
              contactPhone: command.contactPhone,
              documents,
              secrets,
              reviewSlaDueAt: new Date(now.getTime() + REVIEW_SLA_HOURS * 60 * 60 * 1000),
            },
            session,
          );
          if (!next) throw notFound('Application');

          await media.attachToEntity({
            mediaKeys: documents.map((document) => document.mediaKey),
            target: { type: 'seller_application', id: applicationId },
            expectedPurpose: MediaPurpose.KYC_DOCUMENT,
            ownerId: command.userId,
            session,
          });

          await outboxService.publish(
            {
              type: OnboardingEvents.APPLICATION_SUBMITTED,
              aggregateType: 'seller_application',
              aggregateId: applicationId,
              payload: { applicationId, userId: command.userId, resubmission: next.resubmissionCount },
              actorId: command.userId,
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
        actorId: command.userId,
        actorType: ActorType.USER,
        action: 'onboarding.resubmitted',
        targetType: 'seller_application',
        targetId: applicationId,
        after: { attempt: updated.resubmissionCount },
      });
      return updated;
    },

    async withdraw(applicationId: string, userId: string): Promise<void> {
      const existing = await sellerApplicationRepository.findById(applicationId);
      if (!existing) throw notFound('Application');
      if (existing.userId !== userId) throw notFound('Application', `PERM_SCOPE_DENIED user=${userId}`);
      assertTransition(existing.status, ApplicationStatus.WITHDRAWN);

      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const next = await sellerApplicationRepository.transition(
            applicationId,
            existing.status,
            ApplicationStatus.WITHDRAWN,
            {},
            { from: existing.status, to: ApplicationStatus.WITHDRAWN, by: null, reasonCode: null, reason: 'Withdrawn by applicant' },
            session,
          );
          if (!next) {
            throw new AppError(ErrorCode.RESOURCE_CONFLICT, {
              detail: 'The application changed while it was being withdrawn',
            });
          }
          // Documents for an abandoned application should not be retained.
          await media.detachFromEntity({ type: 'seller_application', id: applicationId }, session);
          await outboxService.publish(
            {
              type: OnboardingEvents.APPLICATION_WITHDRAWN,
              aggregateType: 'seller_application',
              aggregateId: applicationId,
              payload: { applicationId, userId },
              actorId: userId,
              actorType: ActorType.USER,
            },
            session,
          );
        });
      } finally {
        await session.endSession();
      }

      await audit.record({
        actorId: userId,
        actorType: ActorType.USER,
        action: 'onboarding.withdrawn',
        targetType: 'seller_application',
        targetId: applicationId,
      });
    },

    async getMine(userId: string): Promise<ApplicationRecord | null> {
      return sellerApplicationRepository.findLatestForUser(userId);
    },

    async list(query: Record<string, unknown>): Promise<Page<ApplicationRecord>> {
      const parsed = parseQuery(query, APPLICATION_QUERY_SPEC);
      const rows = await sellerApplicationRepository.list(parsed);
      const page = toPage(rows as unknown as Record<string, unknown>[], parsed);
      return {
        items: page.items as unknown as ApplicationRecord[],
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      };
    },

    async getForReview(applicationId: string): Promise<ApplicationRecord> {
      const application = await sellerApplicationRepository.findById(applicationId);
      if (!application) throw notFound('Application');
      return application;
    },

    /**
     * Reveals the applicant's identity numbers to a moderator.
     *
     * This is the only path that decrypts, and it always writes a CRITICAL audit entry.
     * "Who read this person's passport number, and when" is a question that will be asked
     * (COMPLIANCE.md); it needs an answer that does not depend on anyone having remembered
     * to log it at the call site.
     */
    async revealIdentity(applicationId: string, moderatorId: string): Promise<RevealedIdentity> {
      const application = await sellerApplicationRepository.findByIdWithSecrets(applicationId);
      if (!application) throw notFound('Application');

      const revealed: RevealedIdentity = {
        passportSeries: decryptField(application.passportSeriesEncrypted),
        passportNumber: decryptField(application.passportNumberEncrypted),
        stir: decryptField(application.stirEncrypted),
      };

      await audit.record({
        actorId: moderatorId,
        actorType: ActorType.ADMIN,
        action: 'onboarding.identity_revealed',
        targetType: 'seller_application',
        targetId: applicationId,
        after: {
          applicantId: application.userId,
          // The audit trail records that it happened, not the value itself.
          passport: maskDocumentNumber(`${revealed.passportSeries}${revealed.passportNumber}`),
        },
        severity: AuditSeverity.CRITICAL,
      });

      return revealed;
    },

    async claim(applicationId: string, moderatorId: string): Promise<ApplicationRecord> {
      const existing = await sellerApplicationRepository.findById(applicationId);
      if (!existing) throw notFound('Application');
      assertTransition(existing.status, ApplicationStatus.UNDER_REVIEW);

      const claimed = await sellerApplicationRepository.transition(
        applicationId,
        ApplicationStatus.SUBMITTED,
        ApplicationStatus.UNDER_REVIEW,
        { reviewerId: new mongoose.Types.ObjectId(moderatorId), reviewStartedAt: new Date() },
        { from: existing.status, to: ApplicationStatus.UNDER_REVIEW, by: new mongoose.Types.ObjectId(moderatorId), reasonCode: null, reason: null },
      );
      if (!claimed) {
        // Another moderator got there first. Losing the race is normal, not an error state.
        throw new AppError(ErrorCode.RESOURCE_CONFLICT, {
          detail: 'This application has already been claimed by another moderator',
        });
      }
      return claimed;
    },

    /**
     * Approves an application: grants the seller role and authorises the market.
     *
     * The shop itself is created afterwards by the seller, not here — see ADR-0031. Approval
     * and shop creation are separate decisions, and binding them would let a stall-number
     * conflict block a moderator's verdict.
     */
    async approve(applicationId: string, moderatorId: string): Promise<ApplicationRecord> {
      const existing = await sellerApplicationRepository.findByIdWithSecrets(applicationId);
      if (!existing) throw notFound('Application');
      assertTransition(existing.status, ApplicationStatus.APPROVED);

      // Re-checked at the moment of approval, not only at submission: another application
      // with the same identity may have been approved while this one sat in the queue.
      await assertIdentityNotAlreadyApproved(
        { passportBlindIndex: existing.passportBlindIndex, stirBlindIndex: existing.stirBlindIndex },
        existing.userId,
      );

      const session = await mongoose.startSession();
      let approved: ApplicationRecord;
      try {
        approved = await session.withTransaction(async () => {
          const next = await sellerApplicationRepository.transition(
            applicationId,
            ApplicationStatus.UNDER_REVIEW,
            ApplicationStatus.APPROVED,
            {
              reviewedAt: new Date(),
              approvedMarketId: new mongoose.Types.ObjectId(existing.marketId),
              rejectionReasonCode: null,
              rejectionReason: null,
            },
            { from: ApplicationStatus.UNDER_REVIEW, to: ApplicationStatus.APPROVED, by: new mongoose.Types.ObjectId(moderatorId), reasonCode: null, reason: null },
            session,
          );
          if (!next) {
            throw new AppError(ErrorCode.RESOURCE_CONFLICT, {
              detail: 'The application changed while it was being approved',
            });
          }

          // The role grant commits with the decision. Approving without granting would leave
          // a seller who has been told yes and cannot act on it.
          await userShopLinkService.grantSellerRole(existing.userId, session);

          await outboxService.publish(
            {
              type: OnboardingEvents.APPLICATION_APPROVED,
              aggregateType: 'seller_application',
              aggregateId: applicationId,
              payload: { applicationId, userId: existing.userId, marketId: existing.marketId },
              actorId: moderatorId,
              actorType: ActorType.ADMIN,
            },
            session,
          );
          return next;
        });
      } finally {
        await session.endSession();
      }

      await audit.record({
        actorId: moderatorId,
        actorType: ActorType.ADMIN,
        action: 'onboarding.approved',
        targetType: 'seller_application',
        targetId: applicationId,
        after: { applicantId: existing.userId, marketId: existing.marketId },
        severity: AuditSeverity.WARNING,
      });
      logger.info({ applicationId, userId: existing.userId }, 'seller application approved');
      return approved;
    },

    async reject(
      applicationId: string,
      moderatorId: string,
      decision: { reasonCode: RejectionReasonCode; reason: string },
    ): Promise<ApplicationRecord> {
      const existing = await sellerApplicationRepository.findById(applicationId);
      if (!existing) throw notFound('Application');
      assertTransition(existing.status, ApplicationStatus.REJECTED);

      const session = await mongoose.startSession();
      let rejected: ApplicationRecord;
      try {
        rejected = await session.withTransaction(async () => {
          const next = await sellerApplicationRepository.transition(
            applicationId,
            ApplicationStatus.UNDER_REVIEW,
            ApplicationStatus.REJECTED,
            {
              reviewedAt: new Date(),
              rejectionReasonCode: decision.reasonCode,
              rejectionReason: decision.reason,
            },
            { from: ApplicationStatus.UNDER_REVIEW, to: ApplicationStatus.REJECTED, by: new mongoose.Types.ObjectId(moderatorId), reasonCode: decision.reasonCode, reason: decision.reason },
            session,
          );
          if (!next) {
            throw new AppError(ErrorCode.RESOURCE_CONFLICT, {
              detail: 'The application changed while it was being rejected',
            });
          }
          await outboxService.publish(
            {
              type: OnboardingEvents.APPLICATION_REJECTED,
              aggregateType: 'seller_application',
              aggregateId: applicationId,
              payload: { applicationId, userId: existing.userId, reasonCode: decision.reasonCode },
              actorId: moderatorId,
              actorType: ActorType.ADMIN,
            },
            session,
          );
          return next;
        });
      } finally {
        await session.endSession();
      }

      await audit.record({
        actorId: moderatorId,
        actorType: ActorType.ADMIN,
        action: 'onboarding.rejected',
        targetType: 'seller_application',
        targetId: applicationId,
        reason: decision.reason,
        after: { applicantId: existing.userId, reasonCode: decision.reasonCode },
        severity: AuditSeverity.WARNING,
      });
      return rejected;
    },

    /** Used by the geo module's authorisation check when a seller opens their shop. */
    async isApprovedForMarket(userId: string, marketId: string): Promise<boolean> {
      const latest = await sellerApplicationRepository.findLatestForUser(userId);
      return (
        latest !== null &&
        latest.status === ApplicationStatus.APPROVED &&
        latest.approvedMarketId === marketId
      );
    },
  };
}

export type OnboardingService = ReturnType<typeof createOnboardingService>;
