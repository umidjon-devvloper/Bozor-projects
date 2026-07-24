import { Router } from 'express';
import { mongoHealthy } from '../../db/mongo.js';
import { redisHealthy } from '../../db/redis.js';
import { asyncHandler } from '../../shared/asyncHandler.js';
import type { VirusScanner } from '../media/index.js';

export function createHealthRouter(dependencies: { scanner: VirusScanner }): Router {
  const router = Router();

  /** Liveness: is the process alive? Never checks dependencies, or a Redis blip restarts pods. */
  router.get('/live', (_req, res) => {
    res.status(200).json({ status: 'ok', uptime: process.uptime() });
  });

  /** Readiness: can this instance serve traffic? Fails the pod out of the load balancer. */
  router.get(
    '/ready',
    asyncHandler(async (_req, res) => {
      // The scanner is included because uploads fail closed without it (ADR-0030): an
      // instance that cannot scan is not fully able to serve, and readiness should say so.
      const checks = {
        mongo: mongoHealthy(),
        redis: await redisHealthy(),
        scanner: await dependencies.scanner.ping(),
      };
      const ready = checks.mongo && checks.redis;
      res
        .status(ready ? 200 : 503)
        .json({ status: ready && checks.scanner ? 'ok' : 'degraded', dependencies: checks });
    }),
  );

  return router;
}
