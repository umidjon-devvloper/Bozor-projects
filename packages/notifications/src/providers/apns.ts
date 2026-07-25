import { connect, constants, type ClientHttp2Session } from 'node:http2';
import jwt from 'jsonwebtoken';
import type { PushMessage, PushProvider, PushResult } from './types.js';

/**
 * Apple Push Notification service, token-based over HTTP/2.
 *
 * APNs requires HTTP/2 and rewards a long-lived connection: Apple explicitly asks that the
 * session be reused rather than reopened per notification. Node's built-in `http2` does this
 * without a dependency, which also means no vendor library sitting between us and the error
 * codes that decide whether a device token is retired.
 */
export interface ApnsCredentials {
  keyId: string;
  teamId: string;
  /** Contents of the .p8 signing key. */
  privateKey: string;
  bundleId: string;
  production: boolean;
}

const PRODUCTION_HOST = 'https://api.push.apple.com';
const SANDBOX_HOST = 'https://api.sandbox.push.apple.com';
const REQUEST_TIMEOUT_MS = 10_000;
/** Apple invalidates provider tokens older than an hour and rejects refreshes under 20 min. */
const TOKEN_TTL_MS = 45 * 60 * 1000;

export function createApnsProvider(credentials: ApnsCredentials): PushProvider {
  const host = credentials.production ? PRODUCTION_HOST : SANDBOX_HOST;
  let session: ClientHttp2Session | null = null;
  let providerToken: string | null = null;
  let tokenIssuedAt = 0;

  function currentToken(): string {
    if (providerToken && Date.now() - tokenIssuedAt < TOKEN_TTL_MS) return providerToken;
    providerToken = jwt.sign({}, credentials.privateKey, {
      algorithm: 'ES256',
      issuer: credentials.teamId,
      header: { alg: 'ES256', kid: credentials.keyId },
    });
    tokenIssuedAt = Date.now();
    return providerToken;
  }

  function getSession(): ClientHttp2Session {
    if (session && !session.closed && !session.destroyed) return session;
    session = connect(host);
    // A dead session must not be reused; the next send opens a fresh one.
    session.on('error', () => {
      session?.destroy();
      session = null;
    });
    session.on('close', () => {
      session = null;
    });
    return session;
  }

  function sendOne(message: PushMessage): Promise<PushResult> {
    return new Promise((resolve) => {
      const payload = JSON.stringify({
        aps: {
          alert: { title: message.title, body: message.body },
          sound: 'default',
          badge: 1,
          'mutable-content': 1,
        },
        ...message.data,
        ...(message.targetUrl ? { targetUrl: message.targetUrl } : {}),
      });

      let stream;
      try {
        stream = getSession().request({
          [constants.HTTP2_HEADER_METHOD]: 'POST',
          [constants.HTTP2_HEADER_PATH]: `/3/device/${message.token}`,
          authorization: `bearer ${currentToken()}`,
          'apns-topic': credentials.bundleId,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        });
      } catch (cause) {
        resolve({
          token: message.token,
          ok: false,
          messageId: null,
          errorCode: 'UNAVAILABLE',
          errorMessage: cause instanceof Error ? cause.message : 'session unavailable',
        });
        return;
      }

      let status = 0;
      let apnsId: string | null = null;
      let body = '';
      const timer = setTimeout(() => {
        stream.close();
        resolve({ token: message.token, ok: false, messageId: null, errorCode: 'TIMEOUT', errorMessage: 'apns timed out' });
      }, REQUEST_TIMEOUT_MS);

      stream.on('response', (headers) => {
        status = Number(headers[constants.HTTP2_HEADER_STATUS] ?? 0);
        apnsId = (headers['apns-id'] as string | undefined) ?? null;
      });
      stream.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      // The stream's error is untyped, and a provider failure message ends up in an operator's
      // log — `[object Object]` there is a failure nobody can diagnose.
      stream.on('error', (error: unknown) => {
        clearTimeout(timer);
        resolve({
          token: message.token,
          ok: false,
          messageId: null,
          errorCode: 'UNAVAILABLE',
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      });
      stream.on('end', () => {
        clearTimeout(timer);
        if (status === 200) {
          resolve({ token: message.token, ok: true, messageId: apnsId, errorCode: null, errorMessage: null });
          return;
        }
        // Apple's reason string is the whole verdict: BadDeviceToken means retire the token,
        // TooManyProviderTokenUpdates means back off and retry.
        const parsed = (() => {
          try {
            return JSON.parse(body) as { reason?: string };
          } catch {
            return {};
          }
        })();
        resolve({
          token: message.token,
          ok: false,
          messageId: apnsId,
          errorCode: parsed.reason ?? `HTTP_${status}`,
          errorMessage: parsed.reason ?? null,
        });
      });

      stream.end(payload);
    });
  }

  return {
    name: 'apns',
    platform: 'IOS',
    async healthy(): Promise<boolean> {
      try {
        await Promise.resolve();
        currentToken();
        const active = getSession();
        return !active.destroyed;
      } catch {
        return false;
      }
    },
    async send(messages: readonly PushMessage[]): Promise<PushResult[]> {
      return Promise.all(messages.map((message) => sendOne(message)));
    },
  };
}
