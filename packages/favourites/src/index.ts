export {
  FavouriteTarget,
  AlertKind,
  PRICE_DROP_MIN_BP,
  PRICE_DROP_MIN_MINOR,
  PRICE_ALERT_COOLDOWN_HOURS,
  RESTOCK_ALERT_COOLDOWN_HOURS,
  ALERT_FANOUT_BATCH_SIZE,
  MAX_FAVOURITES_PER_USER,
} from './constants.js';
export {
  decideProductAlerts,
  isMeaningfulDrop,
  type FavouriteAlertState,
  type ProductAlertInputs,
  type AlertDecision,
} from './alertPolicy.js';
export { FavouriteModel, type FavouriteDoc } from './models/favourite.model.js';
export { favouriteRepository, type FavouriteRecord } from './repositories/favourite.repository.js';
export {
  createFavouriteAlertService,
  type FavouriteAlertService,
  type FavouriteAlertPorts,
  type ProductSnapshot,
  type FanOutResult,
} from './alertService.js';
