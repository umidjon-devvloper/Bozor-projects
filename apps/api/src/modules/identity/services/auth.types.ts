import type { z } from 'zod';
import type { ChangePasswordRequestSchema } from '@bozorlar/contracts';

/**
 * Service-layer input types for the auth service.
 *
 * RECONSTRUCTED during repository recovery. These are the validated request bodies rather
 * than independent declarations: the router validates against the contract schema and hands
 * the result straight to the service, so a second hand-written shape here could drift from
 * the schema that actually guards the endpoint.
 */
export type { LoginRequest, RegisterRequest } from '@bozorlar/contracts';
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;
