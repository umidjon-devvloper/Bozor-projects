import type { PushMessage, PushProvider, PushResult } from './types.js';

/**
 * Expo push service.
 *
 * The mobile app is built with Expo, and Expo tokens (`ExponentPushToken[...]`) are not FCM
 * or APNs tokens — they are routed through Expo's own service. Keeping this as a third
 * provider rather than trying to normalise means development builds work without native
 * credentials, which is most of the time for most of the team.
 */
const ENDPOINT = 'https://exp.host/--/api/v2/push/send';
const REQUEST_TIMEOUT_MS = 10_000;
/** Expo accepts up to 100 messages per request. */
const BATCH_SIZE = 100;

interface ExpoTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

export function createExpoProvider(accessToken: string | null): PushProvider {
  return {
    name: 'expo',
    platform: 'ANY',

    /** Expo needs no credential check; the token is validated per send. */
    healthy(): Promise<boolean> {
      return Promise.resolve(true);
    },

    async send(messages: readonly PushMessage[]): Promise<PushResult[]> {
      const results: PushResult[] = [];

      for (let offset = 0; offset < messages.length; offset += BATCH_SIZE) {
        const batch = messages.slice(offset, offset + BATCH_SIZE);
        try {
          const response = await fetch(ENDPOINT, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
            },
            body: JSON.stringify(
              batch.map((message) => ({
                to: message.token,
                title: message.title,
                body: message.body,
                data: {
                  ...message.data,
                  ...(message.targetUrl ? { targetUrl: message.targetUrl } : {}),
                },
                sound: 'default',
                priority: 'high',
                channelId: 'bozorlar_orders',
              })),
            ),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });

          if (!response.ok) {
            for (const message of batch) {
              results.push({
                token: message.token,
                ok: false,
                messageId: null,
                errorCode: `HTTP_${response.status}`,
                errorMessage: 'expo request failed',
              });
            }
            continue;
          }

          const payload = (await response.json()) as { data?: ExpoTicket[] };
          // Tickets come back positionally, so a missing one is treated as a failure rather
          // than silently mapped to the wrong device.
          batch.forEach((message, index) => {
            const ticket = payload.data?.[index];
            if (!ticket) {
              results.push({ token: message.token, ok: false, messageId: null, errorCode: 'INTERNAL', errorMessage: 'no ticket returned' });
              return;
            }
            results.push(
              ticket.status === 'ok'
                ? { token: message.token, ok: true, messageId: ticket.id ?? null, errorCode: null, errorMessage: null }
                : {
                    token: message.token,
                    ok: false,
                    messageId: null,
                    errorCode: ticket.details?.error ?? 'INTERNAL',
                    errorMessage: ticket.message ?? null,
                  },
            );
          });
        } catch (cause) {
          for (const message of batch) {
            results.push({
              token: message.token,
              ok: false,
              messageId: null,
              errorCode: 'TIMEOUT',
              errorMessage: cause instanceof Error ? cause.message : 'unknown',
            });
          }
        }
      }

      return results;
    },
  };
}
