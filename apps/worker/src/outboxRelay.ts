import mongoose from 'mongoose';
import type { Logger } from '@bozorlar/logger';
import type { EventDispatcher } from './eventDispatcher.js';

const BATCH_SIZE = 100;
const POLL_INTERVAL_MS = 500;

/**
 * Outbox relay (ADR-0012).
 *
 * Reads events committed by the API and hands them to the dispatcher. Delivery is
 * at-least-once: a crash between dispatching and marking a row published redelivers it on
 * restart, which is why every handler is required to be idempotent. A BullMQ transport
 * replaces the in-process dispatcher in Phase 8; the contract does not change.
 *
 * This process must run as a single replica, or with a Redis lock: several relays polling
 * the same partial index will publish the same event repeatedly, and while consumers are
 * idempotent, duplicate work is still load nobody asked for (QUEUE_SYSTEM.md).
 */
export function createOutboxRelay(logger: Logger, dispatcher: EventDispatcher) {
  let running = false;

  async function drain(): Promise<number> {
    const collection = mongoose.connection.db?.collection('outbox');
    if (!collection) return 0;

    const batch = await collection
      .find({ publishedAt: null })
      .sort({ occurredAt: 1 })
      .limit(BATCH_SIZE)
      .toArray();
    if (batch.length === 0) return 0;

    for (const event of batch) {
      try {
        await dispatcher.dispatch({
          eventId: String(event.eventId),
          type: String(event.type),
          aggregateType: String(event.aggregateType),
          aggregateId: String(event.aggregateId),
          payload: (event.payload ?? {}) as Record<string, unknown>,
          traceId: event.traceId ? String(event.traceId) : null,
          occurredAt: event.occurredAt instanceof Date ? event.occurredAt : new Date(),
        });
        await collection.updateOne({ _id: event._id }, { $set: { publishedAt: new Date() } });
      } catch (error) {
        await collection.updateOne(
          { _id: event._id },
          {
            $inc: { attempts: 1 },
            $set: { lastError: error instanceof Error ? error.message : 'unknown' },
          },
        );
        logger.error({ err: error, eventId: event.eventId }, 'failed to relay event');
      }
    }
    return batch.length;
  }

  return {
    async start(): Promise<void> {
      running = true;
      logger.info('outbox relay started');
      while (running) {
        try {
          const processed = await drain();
          if (processed === 0) {
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
          }
        } catch (error) {
          logger.error({ err: error }, 'outbox relay iteration failed');
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
      }
    },
    stop(): void {
      running = false;
      logger.info('outbox relay stopping');
    },
  };
}
