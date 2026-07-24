import { resolveLocalized, type Locale, type LocalizedText } from '@bozorlar/types';
import { MAX_RESUBMISSIONS } from '../onboarding.constants.js';
import type { ApplicationRecord } from '../repositories/sellerApplication.repository.js';

export interface ViewOptions {
  locale: Locale;
  raw: boolean;
  /** Moderators and admins see reviewer attribution and the SLA clock. */
  privileged: boolean;
}

function text(value: LocalizedText, options: ViewOptions): string | LocalizedText {
  return options.raw ? value : resolveLocalized(value, options.locale);
}

/**
 * Application serializer.
 *
 * There is no branch here that can emit an identity field: the record type this receives
 * does not carry them. Reading a passport number requires the separate, audited reveal
 * endpoint, so no future change to this function can leak one by accident.
 */
export function toApplicationResponse(application: ApplicationRecord, options: ViewOptions) {
  return {
    id: application.id,
    marketId: application.marketId,
    shopName: text(application.shopName, options),
    contactPhone: application.contactPhone,
    documents: application.documents.map((document) => ({
      type: document.type,
      mediaKey: document.mediaKey,
      uploadedAt: document.uploadedAt.toISOString(),
    })),
    status: application.status,
    submittedAt: application.submittedAt?.toISOString() ?? null,
    reviewedAt: application.reviewedAt?.toISOString() ?? null,
    rejectionReasonCode: application.rejectionReasonCode,
    rejectionReason: application.rejectionReason,
    resubmissionCount: application.resubmissionCount,
    resubmissionsRemaining: Math.max(0, MAX_RESUBMISSIONS - application.resubmissionCount),
    approvedMarketId: application.approvedMarketId,
    createdAt: application.createdAt.toISOString(),
    ...(options.privileged
      ? {
          applicantId: application.userId,
          reviewerId: application.reviewerId,
          reviewSlaDueAt: application.reviewSlaDueAt?.toISOString() ?? null,
          slaBreached:
            application.reviewSlaDueAt !== null &&
            application.reviewedAt === null &&
            application.reviewSlaDueAt.getTime() < Date.now(),
          statusHistory: application.statusHistory.map((change) => ({
            from: change.from,
            to: change.to,
            at: change.at.toISOString(),
            reasonCode: change.reasonCode,
            reason: change.reason,
          })),
        }
      : {}),
  };
}
