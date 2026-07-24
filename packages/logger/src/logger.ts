import { pino, stdTimeFunctions, type Logger } from 'pino';
import { getContext } from './context.js';

/**
 * Never log these, in any shape. A token in a log file is a valid token
 * (SECURITY.md "Data protection").
 */
const REDACT_PATHS = [
  'password',
  'newPassword',
  'currentPassword',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'tokenHash',
  'code',
  'codeHash',
  'otp',
  'totpCode',
  'twoFactorSecret',
  'passportSeries',
  'passportNumber',
  'authorization',
  'cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  'body.password',
  'body.newPassword',
  'body.currentPassword',
  'body.code',
];

export interface LoggerOptions {
  service: string;
  level: string;
  pretty: boolean;
}

export function createLogger({ service, level, pretty }: LoggerOptions): Logger {
  return pino({
    level,
    base: { service },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    timestamp: stdTimeFunctions.isoTime,
    formatters: { level: (label: string) => ({ level: label }) },
    // Correlation is automatic: every line inside a request carries requestId and traceId,
    // so a push notification can be traced back to the HTTP call that caused it.
    mixin() {
      const context = getContext();
      if (!context) return {};
      return {
        requestId: context.requestId,
        traceId: context.traceId,
        ...(context.userId !== undefined ? { userId: context.userId } : {}),
      };
    },
    ...(pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
      : {}),
  });
}
