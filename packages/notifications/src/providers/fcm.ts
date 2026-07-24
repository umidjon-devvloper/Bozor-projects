import jwt from 'jsonwebtoken';
import type { PushMessage, PushProvider, PushResult } from './types.js';

/**
 * Firebase Cloud Messaging, HTTP v1.
 *
 * Implemented against the published protocol rather than the Firebase SDK: the SDK pulls in a
 * large dependency tree to do an OAuth2 exchange and one HTTPS POST, and the token lifecycle
 * is the only interesting part. Legacy FCM is deliberately not used — Google has retired it,
 * and its per-token error semantics were vaguer than v1's.
 */
export interface FcmCredentials {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const REQUEST_TIMEOUT_MS = 10_000;

export function createFcmProvider(credentials: FcmCredentials): PushProvider {
  let accessToken: string | null = null;
  let expiresAt = 0;

  /**
   * Service-account OAuth2. The assertion is short-lived and the access token is cached until
   * a minute before expiry, so a burst of pushes costs one exchange rather than one per send.
   */
  async function authenticate(): Promise<string> {
    if (accessToken && Date.now() < expiresAt) return accessToken;

    const now = Math.floor(Date.now() / 1000);
    const assertion = jwt.sign(
      { scope: SCOPE },
      credentials.privateKey,
      {
        algorithm: 'RS256',
        issuer: credentials.clientEmail,
        audience: TOKEN_ENDPOINT,
        expiresIn: 3600,
        notBefore: 0,
        header: { alg: 'RS256', typ: 'JWT' },
      },
    );

    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`FCM token exchange failed with ${response.status}`);
    }
    const payload = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!payload.access_token) throw new Error('FCM token exchange returned no access token');

    accessToken = payload.access_token;
    expiresAt = (now + (payload.expires_in ?? 3600) - 60) * 1000;
    return accessToken;
  }

  return {
    name: 'fcm',
    platform: 'ANDROID',

    async healthy(): Promise<boolean> {
      try {
        await authenticate();
        return true;
      } catch {
        return false;
      }
    },

    /**
     * v1 has no batch endpoint, so this is one request per token, issued concurrently.
     * A failure is per-token by design: one dead device must not stop the other four hundred.
     */
    async send(messages: readonly PushMessage[]): Promise<PushResult[]> {
      const token = await authenticate();
      const endpoint = `https://fcm.googleapis.com/v1/projects/${credentials.projectId}/messages:send`;

      return Promise.all(
        messages.map(async (message): Promise<PushResult> => {
          try {
            const response = await fetch(endpoint, {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                message: {
                  token: message.token,
                  notification: { title: message.title, body: message.body },
                  data: {
                    ...message.data,
                    ...(message.targetUrl ? { targetUrl: message.targetUrl } : {}),
                  },
                  android: {
                    priority: 'high',
                    notification: { channelId: 'bozorlar_orders', sound: 'default' },
                  },
                },
              }),
              signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });

            if (response.ok) {
              const body = (await response.json()) as { name?: string };
              return { token: message.token, ok: true, messageId: body.name ?? null, errorCode: null, errorMessage: null };
            }

            const error = (await response.json().catch(() => ({}))) as {
              error?: { status?: string; message?: string; details?: Array<{ errorCode?: string }> };
            };
            // The per-token verdict lives in details[].errorCode; status is the transport-level
            // one. Reporting both keeps retry-versus-retire decisions accurate.
            const errorCode =
              error.error?.details?.find((detail) => detail.errorCode)?.errorCode ??
              error.error?.status ??
              `HTTP_${response.status}`;
            return {
              token: message.token,
              ok: false,
              messageId: null,
              errorCode,
              errorMessage: error.error?.message ?? null,
            };
          } catch (cause) {
            return {
              token: message.token,
              ok: false,
              messageId: null,
              errorCode: 'TIMEOUT',
              errorMessage: cause instanceof Error ? cause.message : 'unknown',
            };
          }
        }),
      );
    },
  };
}
