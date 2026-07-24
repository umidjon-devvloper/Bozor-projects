/**
 * Identity domain events (EVENTS.md).
 *
 * RECONSTRUCTED during repository recovery. The two constant names are proved by their call
 * sites in `auth.service.ts`; the wire strings follow the `domain.snake_case` convention used
 * by every surviving events file. No consumer subscribes to either event today, so the string
 * values are not load-bearing — but they are the one thing here that could not be proved.
 */
export const IdentityEvents = {
  USER_REGISTERED: 'user.registered',
  USER_PHONE_VERIFIED: 'user.phone_verified',
} as const;

export type IdentityEvent = (typeof IdentityEvents)[keyof typeof IdentityEvents];
