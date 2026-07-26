import type { ClientSession } from 'mongoose';
import { OutboxModel, type OutboxDoc } from './outbox.model.js';

/** The outbox module's data access — see the note in `audit.repository.ts`. */
export const outboxRepository = {
  /**
   * Writes one event.
   *
   * The session is not optional at the call that matters: an event published outside the
   * transaction that produced it is an event that can survive a rolled-back write (ADR-0012).
   * `create` is given an array when a session is present because that is the only overload
   * that accepts one.
   */
  async insert(doc: Partial<OutboxDoc>, session?: ClientSession): Promise<void> {
    if (session) await OutboxModel.create([doc], { session });
    else await OutboxModel.create(doc);
  },
};
