import { randomUUID } from 'node:crypto';
import { Types, type ClientSession } from 'mongoose';
import { getContext } from '@bozorlar/logger';
import { outboxRepository } from './outbox.repository.js';

export interface DomainEventInput {
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  actorId?: string | null;
  actorType?: string;
  version?: number;
}

export const outboxService = {
  /**
   * MUST be called with the session of the transaction that performs the state change.
   * Publishing outside the transaction reintroduces the dual-write problem the outbox exists
   * to solve, so the session parameter is required rather than optional.
   */
  async publish(event: DomainEventInput, session: ClientSession): Promise<string> {
    const eventId = randomUUID();
    await outboxRepository.insert(
      {
        eventId,
        type: event.type,
        version: event.version ?? 1,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        payload: event.payload,
        traceId: getContext()?.traceId ?? null,
        actorId: event.actorId ? new Types.ObjectId(event.actorId) : null,
        actorType: event.actorType ?? 'SYSTEM',
        occurredAt: new Date(),
      },
      session,
    );
    return eventId;
  },

  /**
   * Escape hatch for events that accompany no transactional state change (for example a
   * delivery notification). Anything touching money must use `publish` with a session.
   */
  async publishStandalone(event: DomainEventInput): Promise<string> {
    const eventId = randomUUID();
    await outboxRepository.insert({
      eventId,
      type: event.type,
      version: event.version ?? 1,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      payload: event.payload,
      traceId: getContext()?.traceId ?? null,
      actorId: event.actorId ? new Types.ObjectId(event.actorId) : null,
      actorType: event.actorType ?? 'SYSTEM',
      occurredAt: new Date(),
    });
    return eventId;
  },
};
