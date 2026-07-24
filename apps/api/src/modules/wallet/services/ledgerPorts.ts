import type { ClientSession } from 'mongoose';
import { ActorType, AuditSeverity } from '@bozorlar/types';
import type { AuditRecorder, EventPublisher } from '@bozorlar/ledger';
import { outboxService } from '../../outbox/index.js';
import type { AuditService } from '../../audit/index.js';

/**
 * The API's implementations of the ledger's ports.
 *
 * Events go through the transactional outbox, so a commission charge and its notification
 * cannot exist without each other (ADR-0012). The worker supplies its own equivalents.
 */
export function createApiEventPublisher(): EventPublisher {
  return {
    async publish(event, session: ClientSession): Promise<void> {
      await outboxService.publish(
        {
          type: event.type,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          payload: event.payload,
          actorId: event.actorId ?? null,
          actorType: event.actorId ? ActorType.ADMIN : ActorType.SYSTEM,
        },
        session,
      );
    },
  };
}

export function createApiAuditRecorder(audit: AuditService): AuditRecorder {
  return {
    async record(entry): Promise<void> {
      await audit.record({
        actorId: entry.actorId ?? null,
        actorType: entry.actorId ? ActorType.ADMIN : ActorType.SYSTEM,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId ?? null,
        after: entry.after ?? null,
        reason: entry.reason ?? null,
        severity: entry.critical === true ? AuditSeverity.CRITICAL : AuditSeverity.INFO,
      });
    },
  };
}
