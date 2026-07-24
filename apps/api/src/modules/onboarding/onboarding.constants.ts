/**
 * Seller application lifecycle.
 *
 * DRAFT exists so a seller can gather documents across sessions without a half-finished
 * application appearing in the moderation queue.
 */
export const ApplicationStatus = {
  DRAFT: 'DRAFT',
  SUBMITTED: 'SUBMITTED',
  UNDER_REVIEW: 'UNDER_REVIEW',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  WITHDRAWN: 'WITHDRAWN',
} as const;
export type ApplicationStatus = (typeof ApplicationStatus)[keyof typeof ApplicationStatus];

/**
 * Legal transition table. Declared once and checked centrally, so an illegal move throws
 * rather than silently producing an application in an impossible state.
 */
export const APPLICATION_TRANSITIONS: Readonly<Record<ApplicationStatus, readonly ApplicationStatus[]>> = {
  DRAFT: [ApplicationStatus.SUBMITTED, ApplicationStatus.WITHDRAWN],
  SUBMITTED: [ApplicationStatus.UNDER_REVIEW, ApplicationStatus.WITHDRAWN],
  UNDER_REVIEW: [ApplicationStatus.APPROVED, ApplicationStatus.REJECTED],
  // A rejected application is resubmitted, not edited in place: the previous decision and
  // the evidence it was made on must remain readable.
  REJECTED: [ApplicationStatus.SUBMITTED],
  APPROVED: [],
  WITHDRAWN: [],
};

export const TERMINAL_STATUSES: readonly ApplicationStatus[] = [
  ApplicationStatus.APPROVED,
  ApplicationStatus.WITHDRAWN,
];

export const DocumentType = {
  PASSPORT: 'PASSPORT',
  STIR_CERTIFICATE: 'STIR_CERTIFICATE',
  MARKET_CONTRACT: 'MARKET_CONTRACT',
  SHOP_PHOTO: 'SHOP_PHOTO',
} as const;
export type DocumentType = (typeof DocumentType)[keyof typeof DocumentType];

/** Without these a moderator cannot verify identity, so submission is refused. */
export const REQUIRED_DOCUMENTS: readonly DocumentType[] = [
  DocumentType.PASSPORT,
  DocumentType.MARKET_CONTRACT,
];

export const RejectionReasonCode = {
  DOCUMENT_UNREADABLE: 'DOCUMENT_UNREADABLE',
  DOCUMENT_MISMATCH: 'DOCUMENT_MISMATCH',
  IDENTITY_UNVERIFIED: 'IDENTITY_UNVERIFIED',
  STIR_INVALID: 'STIR_INVALID',
  CONTRACT_INVALID: 'CONTRACT_INVALID',
  DUPLICATE_APPLICANT: 'DUPLICATE_APPLICANT',
  PROHIBITED_GOODS: 'PROHIBITED_GOODS',
  OTHER: 'OTHER',
} as const;
export type RejectionReasonCode = (typeof RejectionReasonCode)[keyof typeof RejectionReasonCode];

/**
 * After this many rejections the application stops accepting resubmissions and needs a human
 * to intervene. Without a ceiling, a determined applicant can loop the moderation queue
 * indefinitely at zero cost to themselves (MODERATION.md).
 */
export const MAX_RESUBMISSIONS = 3;

/** Documents attached to an application, in upload order, capped to keep the doc bounded. */
export const MAX_DOCUMENTS = 10;

/** Moderation SLA for the queue view (MODERATION.md: seller applications, 24h). */
export const REVIEW_SLA_HOURS = 24;
