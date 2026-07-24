/**
 * Public surface of the onboarding module (ADR-0011 rule 1).
 *
 * `isApprovedForMarket` is the only capability other modules consume; everything about
 * identity documents stays inside.
 */
export {
  createOnboardingService,
  type OnboardingService,
  type SubmitApplicationCommand,
  type MarketLookup,
} from './services/onboarding.service.js';
export {
  createOnboardingController,
  type OnboardingController,
} from './http/onboarding.controller.js';
export {
  createApplicationRouter,
  createApplicationAdminRouter,
} from './http/onboarding.routes.js';
export {
  ApplicationStatus,
  APPLICATION_TRANSITIONS,
  DocumentType,
  RejectionReasonCode,
  REQUIRED_DOCUMENTS,
  MAX_RESUBMISSIONS,
} from './onboarding.constants.js';
export { normaliseIdentityDocuments } from './services/identityDocuments.service.js';
export { OnboardingEvents } from './events.js';
