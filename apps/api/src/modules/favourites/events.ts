/** Favourites domain events (EVENTS.md). */
export const FavouriteEvents = {
  ADDED: 'favourite.added',
  REMOVED: 'favourite.removed',
  /** Emitted by the worker after a fan-out, so analytics can measure alert reach. */
  ALERTS_SENT: 'favourite.alerts_sent',
} as const;

export type FavouriteEvent = (typeof FavouriteEvents)[keyof typeof FavouriteEvents];
