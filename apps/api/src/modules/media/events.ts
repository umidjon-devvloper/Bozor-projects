/** Media domain events (EVENTS.md). */
export const MediaEvents = {
  UPLOAD_REQUESTED: 'media.upload_requested',
  UPLOAD_CONFIRMED: 'media.upload_confirmed',
  UPLOAD_REJECTED: 'media.upload_rejected',
  ASSET_ATTACHED: 'media.asset_attached',
  ASSET_ORPHANED: 'media.asset_orphaned',
  PRIVATE_ACCESS_GRANTED: 'media.private_access_granted',
} as const;

export type MediaEvent = (typeof MediaEvents)[keyof typeof MediaEvents];
