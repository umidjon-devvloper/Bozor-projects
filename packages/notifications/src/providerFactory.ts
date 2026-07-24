import { env } from '@bozorlar/config';
import { createApnsProvider, createExpoProvider, createFcmProvider } from './providers/index.js';
import type { PushProvider } from './providers/types.js';

/**
 * Builds the providers a deployment is actually configured for.
 *
 * A missing credential means that transport does not exist — not that sending silently
 * succeeds. A deployment with no iOS key genuinely cannot reach iPhones, and the delivery
 * engine records `NO_DEVICE` rather than pretending otherwise.
 */
export function createConfiguredProviders(
  log: (context: Record<string, unknown>, message: string) => void,
): PushProvider[] {
  const providers: PushProvider[] = [];

  if (env.FCM_PROJECT_ID && env.FCM_CLIENT_EMAIL && env.FCM_PRIVATE_KEY) {
    providers.push(
      createFcmProvider({
        projectId: env.FCM_PROJECT_ID,
        clientEmail: env.FCM_CLIENT_EMAIL,
        // PEM keys arrive from the environment with escaped newlines.
        privateKey: env.FCM_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    );
  }

  if (env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_PRIVATE_KEY && env.APNS_BUNDLE_ID) {
    providers.push(
      createApnsProvider({
        keyId: env.APNS_KEY_ID,
        teamId: env.APNS_TEAM_ID,
        privateKey: env.APNS_PRIVATE_KEY.replace(/\\n/g, '\n'),
        bundleId: env.APNS_BUNDLE_ID,
        production: env.APNS_PRODUCTION,
      }),
    );
  }

  // Expo needs no credentials for unauthenticated sends, so it is always available — which is
  // what makes development builds reachable without native certificates.
  providers.push(createExpoProvider(env.EXPO_ACCESS_TOKEN ?? null));

  log({ providers: providers.map((provider) => provider.name) }, 'push providers configured');
  return providers;
}
