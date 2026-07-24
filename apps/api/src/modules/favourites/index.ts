/**
 * Public surface of the favourites module (ADR-0011 rule 1).
 *
 * The model, the repository and the alert policy live in `@bozorlar/favourites` because the
 * worker needs them too and no app may import another app.
 */
export { createFavouriteService, type FavouriteService } from './services/favourite.service.js';
export {
  createFavouriteController,
  type FavouriteController,
} from './http/favourite.controller.js';
export { createFavouriteRouter, createSellerFavouriteRouter } from './http/favourite.routes.js';
export { FavouriteEvents } from './events.js';
