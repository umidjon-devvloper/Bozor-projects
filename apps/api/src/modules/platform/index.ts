/** Public surface of the platform module: liveness, readiness and client configuration. */
export { createHealthRouter } from './health.routes.js';
export { createConfigRouter } from './config.routes.js';
export { IdempotencyKeyModel, type IdempotencyKeyDoc } from './idempotencyKey.model.js';
