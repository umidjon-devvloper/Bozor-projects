import mongoose from 'mongoose';
import type { Logger } from '@bozorlar/logger';
import type { EventDispatcher } from './eventDispatcher.js';

const BATCH_SIZE = 100;
const POLL_INTERVAL_MS = 500;

/**
 * After this many failures an event stops being fetched.
 *
 * Not a dead-letter collection: the row stays in the outbox with its `attempts` and
 * `lastError`, which is where an operator would look for it anyway. What the cap buys is that
 * a permanently undeliverable event — a payload no handler can parse, a handler that always
 * throws — stops being retried forever at the head of the queue.
 *
 * Ten is high enough to ride out an outage of any consumer and low enough that a genuinely
 * broken event is set aside within seconds rather than filling the log for a week.
 *
 * One cost worth knowing: set-aside events stay unpublished, so they remain in the partial
 * index on `{ occurredAt }` and — being the oldest — sit at the head of every subsequent scan.
 * A handful is free; a few hundred accumulated over months would make each drain read past
 * them. The fix when that day comes is a `deadLetteredAt` field in the partial filter, which
 * needs a migration and is not worth one today.
 */
const MAX_ATTEMPTS = 10;

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
      .find({ publishedAt: null, attempts: { $lt: MAX_ATTEMPTS } })
      .sort({ occurredAt: 1 })
      .limit(BATCH_SIZE)
      .toArray();
    if (batch.length === 0) return 0;

    let published = 0;
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
        published += 1;
      } catch (error) {
        await collection.updateOne(
          { _id: event._id },
          {
            $inc: { attempts: 1 },
            $set: { lastError: error instanceof Error ? error.message : 'unknown' },
          },
        );
        const attempts = Number(event.attempts ?? 0) + 1;
        logger.error(
          { err: error, eventId: event.eventId, attempts },
          attempts >= MAX_ATTEMPTS
            ? 'event set aside after too many failed relay attempts'
            : 'failed to relay event',
        );
      }
    }
    /**
     * The count is of events *published*, not events fetched.
     *
     * The caller sleeps only when this is zero, so returning the batch size meant a batch that
     * failed entirely still looked like progress — and one undeliverable event, always first
     * because the sort is oldest-first, kept the relay in a loop with no pause, hammering the
     * database and writing an error line every iteration.
     */
    return published;
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
