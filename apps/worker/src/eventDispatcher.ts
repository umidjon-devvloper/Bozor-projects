import type { Logger } from '@bozorlar/logger';

/**
 * Domain event dispatch for the outbox relay (ADR-0012).
 *
 * Handlers are idempotent by contract, because at-least-once delivery is the only guarantee
 * the outbox provides: a relay that crashes between publishing and marking a row published
 * will deliver it again on restart. An event with no registered handler is not an error —
 * most events exist for consumers that arrive in later phases.
 */
export interface DomainEventEnvelope {
  eventId: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  traceId: string | null;
  occurredAt: Date;
}

export type EventHandler = (event: DomainEventEnvelope) => Promise<void>;

export function createEventDispatcher(logger: Logger) {
  const handlers = new Map<string, EventHandler[]>();

  return {
    on(type: string, handler: EventHandler): void {
      const existing = handlers.get(type) ?? [];
      existing.push(handler);
      handlers.set(type, existing);
    },

    handledTypes(): string[] {
      return [...handlers.keys()];
    },

    /**
     * Runs every handler registered for the event.
     *
     * One failing handler must not deny the others their delivery, so failures are collected
     * and rethrown together — the relay then retries the whole event, which is safe precisely
     * because handlers are idempotent.
     */
    async dispatch(event: DomainEventEnvelope): Promise<void> {
      const registered = handlers.get(event.type);
      if (!registered || registered.length === 0) return;

      const failures: unknown[] = [];
      for (const handler of registered) {
        try {
          await handler(event);
        } catch (error) {
          failures.push(error);
          logger.error({ err: error, eventId: event.eventId, type: event.type }, 'event handler failed');
        }
      }
      if (failures.length > 0) {
        throw new Error(`${failures.length} handler(s) failed for ${event.type}`);
      }
    },
  };
}

export type EventDispatcher = ReturnType<typeof createEventDispatcher>;
