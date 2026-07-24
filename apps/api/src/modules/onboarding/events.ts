/** Onboarding domain events (EVENTS.md). */
export const OnboardingEvents = {
  APPLICATION_SUBMITTED: 'seller.applied',
  APPLICATION_CLAIMED: 'seller.application_claimed',
  APPLICATION_APPROVED: 'seller.approved',
  APPLICATION_REJECTED: 'seller.rejected',
  APPLICATION_WITHDRAWN: 'seller.application_withdrawn',
  DUPLICATE_IDENTITY_DETECTED: 'seller.duplicate_identity_detected',
} as const;

export type OnboardingEvent = (typeof OnboardingEvents)[keyof typeof OnboardingEvents];
