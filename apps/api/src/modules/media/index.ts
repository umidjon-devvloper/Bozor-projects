/**
 * Public surface of the media module (ADR-0011 rule 1).
 *
 * Other modules consume `attachToEntity` / `detachFromEntity` / `resolveMany` inside their
 * own transactions; nothing else about media should be reachable from outside.
 */
export {
  createMediaService,
  type MediaService,
  type MediaActor,
  type ConfirmedAsset,
  type UploadTicket,
} from './services/media.service.js';
export {
  createVirusScanner,
  createClamAvScanner,
  type VirusScanner,
} from './services/virusScanner.service.js';
export { createMediaController, type MediaController } from './http/media.controller.js';
export { createMediaRouter } from './http/media.routes.js';
export {
  MediaPurpose,
  MediaVisibility,
  PURPOSE_POLICIES,
  UNATTACHED_TTL_HOURS,
} from './media.constants.js';
export { MediaStatus } from './models/mediaAsset.model.js';
export { MediaEvents } from './events.js';
