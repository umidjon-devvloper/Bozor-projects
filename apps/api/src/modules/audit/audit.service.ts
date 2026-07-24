import { Types } from 'mongoose';
import { ActorType, AuditSeverity } from '@bozorlar/types';
import { getContext, type Logger } from '@bozorlar/logger';
import { AuditLogModel } from './audit.model.js';

export interface AuditEntry {
  actorId?: string | null;
  actorType: ActorType;
  action: string;
  targetType: string;
  targetId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string | null;
  severity?: AuditSeverity;
}

/** Fields that must never reach the audit trail, however convenient (SECURITY.md). */
const REDACTED_KEYS = new Set([
  'password', 'passwordHash', 'token', 'tokenHash', 'code', 'codeHash',
  'twoFactorSecret', 'passportSeries', 'passportNumber',
]);

function redact(value: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!value) return null;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = REDACTED_KEYS.has(key) ? '[redacted]' : entry;
  }
  return output;
}

export function createAuditService(logger: Logger) {
  return {
    /**
     * Written outside the business transaction, so an audit failure can never roll back a
     * legitimate operation — but awaited before the response, so the trail is not lost on a
     * crash (DATABASE.md 2.1).
     */
    async record(entry: AuditEntry): Promise<void> {
      const context = getContext();
      try {
        await AuditLogModel.create({
          actorId: entry.actorId ? new Types.ObjectId(entry.actorId) : null,
          actorType: entry.actorType,
          action: entry.action,
          targetType: entry.targetType,
          targetId: entry.targetId ?? null,
          before: redact(entry.before),
          after: redact(entry.after),
          reason: entry.reason ?? null,
          ip: context?.ip ?? null,
          userAgent: context?.userAgent ?? null,
          traceId: context?.traceId ?? null,
          severity: entry.severity ?? AuditSeverity.INFO,
        });
      } catch (cause) {
        logger.error({ err: cause, action: entry.action }, 'failed to write audit log');
      }
    },
  };
}

export type AuditService = ReturnType<typeof createAuditService>;
