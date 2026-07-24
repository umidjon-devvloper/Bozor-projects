import type { Locale, UserRole } from '@bozorlar/types';

/**
 * The authenticated caller, resolved once per request by the auth middleware and read by
 * every controller and policy. Permissions are a resolved Set rather than a role list so
 * that a check is O(1) and never re-derives the role table per call.
 *
 * RECONSTRUCTED during repository recovery — the original file was not in the uploaded
 * artifacts. Every field below is required by an existing consumer: `sessionService.resolve`
 * constructs exactly this object, and `policies.ts` reads userId, shopIds and phoneVerified.
 */
export interface AuthContext {
  userId: string;
  sessionId: string;
  deviceId: string;
  roles: readonly UserRole[];
  permissions: Set<string>;
  shopIds: readonly string[];
  phoneVerified: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by the auth middleware once the access token is verified. */
      auth?: AuthContext;
      /** Negotiated response locale, set by requestContext for every request. */
      locale: Locale;
      /** Correlation id echoed as `X-Request-Id` and carried into every log line. */
      requestId: string;
      /**
       * Express 5 exposes `req.query` as a getter, so the validated query is written to a
       * separate field rather than overwriting it. Handlers narrow it with a cast against the
       * schema the route validated with.
       */
      validatedQuery?: unknown;
    }
  }
}
