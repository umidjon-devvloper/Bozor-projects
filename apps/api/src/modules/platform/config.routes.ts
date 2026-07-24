import { Router } from 'express';
import { env } from '@bozorlar/config';
import { LOCALES } from '@bozorlar/types';
import { sendData } from '../../http/envelope.js';

/**
 * Client bootstrap configuration (ADR-0022: configuration is data, not code).
 *
 * RECONSTRUCTED during repository recovery — this is the only file in the restore whose
 * original contents could not be proved by any surviving consumer. `app.ts` proves the
 * factory's name, that it takes no arguments and that it mounts at `/api/v1/config`; the
 * payload below is the documented registry-default set, and PROJECT_STATUS.md records that
 * settings-collection reads were deferred, so serving registry defaults is correct for now.
 * Treat the field list as unverified until checked against the API documentation.
 */
export function createConfigRouter(): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    sendData(res, {
      locales: LOCALES,
      cdnBaseUrl: env.CDN_BASE_URL,
      deepLinkBase: env.APP_DEEP_LINK_BASE,
      features: {
        showClosedShops: false,
      },
    });
  });

  return router;
}
